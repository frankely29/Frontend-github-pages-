from typing import Any, Dict

from fastapi import APIRouter
from pydantic import BaseModel, Field

from admin_test_service import test_build_sync


class AdminDiagnosticResponse(BaseModel):
    ok: bool
    summary: str
    details: Dict[str, Any] = Field(default_factory=dict)


router = APIRouter(prefix="/admin/tests", tags=["admin-tests"])


@router.get("/build-sync", response_model=AdminDiagnosticResponse)
def admin_test_build_sync() -> AdminDiagnosticResponse:
    result = test_build_sync()
    return AdminDiagnosticResponse(**result)
