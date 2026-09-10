/**
 * Which URL an inline chat image loads.
 *
 * Grid tiles (110px) and chat bubbles (220px CSS) load the thumbnail; the
 * full-screen viewer loads the original. Three things have to hold or the
 * change is worse than not making it:
 *
 *   - a server with no thumbnails must fall back to the full image
 *   - the renderers and shouldReuseImageRow must agree on the URL, or no row is
 *     ever reused and every refresh rebuilds the whole conversation
 *   - tapping a thumbnail must still open the full-size viewer
 *
 * app.part8.js is 7,200 lines of browser-coupled code, so rather than load it
 * whole this extracts the functions under test out of the shipped source. A
 * rename or a signature change fails here loudly instead of silently passing.
 */
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'app.part8.js'), 'utf8');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures += 1;
  console.log(`  FAIL ${name}${extra !== undefined ? ` :: ${extra}` : ''}`);
}
function eq(name, got, want) {
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}

/** Pull a named function's source out of app.part8.js by brace matching. */
function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = SRC.indexOf(marker);
  if (start < 0) throw new Error(`${name} not found in app.part8.js`);
  let depth = 0;
  let i = SRC.indexOf('{', start);
  const bodyStart = i;
  for (; i < SRC.length; i += 1) {
    if (SRC[i] === '{') depth += 1;
    else if (SRC[i] === '}') {
      depth -= 1;
      if (depth === 0) return SRC.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces reading ${name} (from ${bodyStart})`);
}

const displayImageUrlForSrc = extractFunction('displayImageUrlFor');
const shouldReuseImageRowSrc = extractFunction('shouldReuseImageRow');

// eslint-disable-next-line no-new-func
const displayImageUrlFor = new Function(`${displayImageUrlForSrc}; return displayImageUrlFor;`)();

// shouldReuseImageRow leans on two helpers whose behaviour is not what is under
// test here, so they are stubbed to something predictable.
// eslint-disable-next-line no-new-func
const shouldReuseImageRow = new Function(
  'displayImageUrlFor', 'messageHasImage', 'getVoiceMessageDomKey',
  `${shouldReuseImageRowSrc}; return shouldReuseImageRow;`
)(
  displayImageUrlFor,
  (m) => !!m?.imageUrl,
  (m) => `key-${m?.id}`
);

const FULL = 'https://api.test/chat/image/public/42';
const THUMB = 'https://api.test/chat/image/public/42/thumb';

console.log('\n-- which URL is displayed --');

eq('a message with a thumbnail displays the thumbnail',
  displayImageUrlFor({ imageUrl: FULL, imageThumbUrl: THUMB }), THUMB);

eq('a message without a thumbnail falls back to the full image',
  displayImageUrlFor({ imageUrl: FULL }), FULL);

eq('an empty thumbnail field falls back rather than displaying nothing',
  displayImageUrlFor({ imageUrl: FULL, imageThumbUrl: '' }), FULL);

eq('a whitespace-only thumbnail falls back too',
  displayImageUrlFor({ imageUrl: FULL, imageThumbUrl: '   ' }), FULL);

eq('a message with neither yields an empty string, not undefined',
  displayImageUrlFor({}), '');

eq('a null message does not throw', displayImageUrlFor(null), '');

console.log('\n-- row reuse must agree with the renderers --');

// This is the regression that would be invisible: rows rendered with the thumb
// URL but compared against the full URL are never reused, so every incoming
// message rebuilds the entire list and every image reloads.
const withThumb = { id: 42, imageUrl: FULL, imageThumbUrl: THUMB };
const rowRenderedWithThumb = {
  dataset: { messageKey: 'key-42', messageId: '42', messageScope: 'public', imageUrl: THUMB },
};
const rowRenderedWithFull = {
  dataset: { messageKey: 'key-42', messageId: '42', messageScope: 'public', imageUrl: FULL },
};

check('a row rendered with the thumbnail is reused',
  shouldReuseImageRow(rowRenderedWithThumb, withThumb, 'public') === true);

check('a stale row still holding the full URL is NOT reused',
  shouldReuseImageRow(rowRenderedWithFull, withThumb, 'public') === false,
  'a row from before this change must be re-rendered once');

const noThumb = { id: 42, imageUrl: FULL };
check('with no thumbnail available, a full-URL row is reused',
  shouldReuseImageRow(rowRenderedWithFull, noThumb, 'public') === true);

check('a different scope is not reused',
  shouldReuseImageRow(rowRenderedWithThumb, withThumb, 'private') === false);

check('a different message id is not reused',
  shouldReuseImageRow(
    { dataset: { messageKey: 'key-42', messageId: '99', messageScope: 'public', imageUrl: THUMB } },
    withThumb, 'public'
  ) === false);

check('a non-image message is never reused as an image row',
  shouldReuseImageRow(rowRenderedWithThumb, { id: 42 }, 'public') === false);

check('a missing row is handled', shouldReuseImageRow(null, withThumb, 'public') === false);

console.log('\n-- the shipped source wires it up --');

// Both renderers must go through the shared helper. If either builds its own
// URL the two can drift apart, which is exactly the reuse bug above.
const galleryUses = /tileImageUrl\s*=\s*String\(msg\?\.imageThumbUrl/.test(SRC);
check('the photo grid resolves a tile URL from imageThumbUrl', galleryUses);

const cardUses = /renderChatImageCard[\s\S]{0,400}?displayImageUrlFor\(message\)/.test(SRC);
check('the chat bubble resolves its URL through displayImageUrlFor', cardUses);

check('the canonical normalizer emits imageThumbUrl',
  /imageThumbUrl:\s*normalizeImageThumbUrl\(raw\)/.test(SRC));

check('the normalizer reads the server field image_thumb_url',
  /raw\?\.image_thumb_url/.test(SRC));

// The viewer must keep loading full resolution — a thumbnail in a full-screen
// viewer is the whole point of this being a two-URL scheme.
check('viewer items still carry the full-resolution URL',
  /imageUrl:\s*String\(msg\?\.imageUrl \|\| ''\)\.trim\(\),\s*\n\s*imageThumbUrl:/.test(SRC),
  'buildPhotoViewerItems must map imageUrl to the original');

check('the viewer can match a tile by its thumbnail URL',
  /String\(item\.imageThumbUrl \|\| ''\) === imageUrlText/.test(SRC),
  'an id-less message opened from a thumbnail must still resolve');

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
