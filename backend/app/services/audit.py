from sqlalchemy.orm import Session

from ..models import AuditLog


def record(db: Session, actor: str, action: str, resource_type: str, resource_id: str | None = None, *, application_id: str | None = None,
           placement_id: str | None = None, campaign_id: str | None = None, bulk_operation_id: str | None = None,
           outcome: str = "success", detail: dict | None = None) -> AuditLog:
    row = AuditLog(actor_email=actor, action=action, resource_type=resource_type, resource_id=resource_id, application_id=application_id,
                   placement_id=placement_id, campaign_id=campaign_id, bulk_operation_id=bulk_operation_id, outcome=outcome, detail=detail)
    db.add(row)
    return row
