import uuid
from datetime import datetime

from sqlalchemy import (JSON, BigInteger, Boolean, CheckConstraint, Float, ForeignKey, Index, Integer, String, Text,
                        UniqueConstraint)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from . import clock
from .db import Base, UTCDateTime

Json = JSON().with_variant(JSONB(), "postgresql")
ASSET_TYPES = ("product_image", "illustration", "texture", "sprite", "background", "banner", "promotional_card", "sticker", "theme_artwork")
FORMATS = ("png", "jpeg", "webp")
ROLES = ("viewer", "editor", "admin")


def _id() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    return clock.now()


class Stamped:
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=_now)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=_now, onupdate=_now)


class User(Base, Stamped):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    email: Mapped[str] = mapped_column(String(254), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(120))
    role: Mapped[str] = mapped_column(String(16), default="viewer")
    password_hash: Mapped[str] = mapped_column(String(255))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    __table_args__ = (CheckConstraint("role in ('viewer','editor','admin')", name="ck_user_role"),)


class Application(Base, Stamped):
    __tablename__ = "applications"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    app_key: Mapped[str] = mapped_column(String(64), unique=True, index=True)  # the public "application ID" the app uses
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    category: Mapped[str | None] = mapped_column(String(60), nullable=True)  # optional label, never used for logic
    platform: Mapped[str] = mapped_column(String(40), default="flutter")
    integration_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    runtime_key_hash: Mapped[str] = mapped_column(String(64))
    runtime_key_prefix: Mapped[str] = mapped_column(String(12))
    config_version: Mapped[int] = mapped_column(Integer, default=1)
    config_snapshot_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    last_seen_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    last_seen_version: Mapped[int | None] = mapped_column(Integer, nullable=True)

    placements: Mapped[list["Placement"]] = relationship(back_populates="application", cascade="all, delete-orphan")


class Placement(Base, Stamped):
    __tablename__ = "placements"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    application_id: Mapped[str] = mapped_column(ForeignKey("applications.id", ondelete="CASCADE"), index=True)
    placement_key: Mapped[str] = mapped_column(String(120))
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    supported_asset_types: Mapped[list] = mapped_column(Json, default=list)
    supported_formats: Mapped[list] = mapped_column(Json, default=lambda: list(FORMATS))
    aspect_ratio: Mapped[float | None] = mapped_column(Float, nullable=True)
    aspect_tolerance: Mapped[float] = mapped_column(Float, default=0.05)
    min_width: Mapped[int | None] = mapped_column(Integer, nullable=True)
    min_height: Mapped[int | None] = mapped_column(Integer, nullable=True)
    max_file_size_bytes: Mapped[int] = mapped_column(Integer, default=2 * 1024 * 1024)
    requires_transparency: Mapped[bool] = mapped_column(Boolean, default=False)
    render: Mapped[dict] = mapped_column(Json, default=dict)
    fallback: Mapped[dict] = mapped_column(Json, default=dict)  # {kind, ref, storage_key?}: the app's own default asset
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    # How the app draws it. "widget": an AdForgeImage the developer placed there. "asset": one of the app's own bundled
    # pictures, "remote": a picture the app loads from a web address; both found by scanning the app's project zip and
    # swapped by AdForge wherever the app loads asset_path (the bundled path, or the web address).
    integration: Mapped[str] = mapped_column(String(12), default="widget", server_default="widget")
    asset_path: Mapped[str | None] = mapped_column(String(2048), nullable=True)
    variants: Mapped[list] = mapped_column(Json, default=list, server_default="[]")  # [{scale, width, height}] as shipped in the app

    application: Mapped[Application] = relationship(back_populates="placements")
    __table_args__ = (
        UniqueConstraint("application_id", "placement_key", name="uq_placement_app_key"),
        CheckConstraint("integration in ('widget','asset','remote')", name="ck_placement_integration"),
        Index("uq_placement_asset_path", "application_id", "asset_path", unique=True, postgresql_where="asset_path is not null",
              sqlite_where="asset_path is not null"),
    )


class Creative(Base, Stamped):
    __tablename__ = "creatives"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    family_id: Mapped[str] = mapped_column(String(36), index=True, default=_id)  # all versions of one creative share this
    version: Mapped[int] = mapped_column(Integer, default=1)
    name: Mapped[str] = mapped_column(String(160))
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    advertiser: Mapped[str] = mapped_column(String(120), index=True)
    product_name: Mapped[str | None] = mapped_column(String(160), nullable=True)
    asset_type: Mapped[str] = mapped_column(String(32))
    storage_key: Mapped[str] = mapped_column(String(200))
    thumbnail_key: Mapped[str] = mapped_column(String(200))
    file_format: Mapped[str] = mapped_column(String(8))
    width: Mapped[int] = mapped_column(Integer)
    height: Mapped[int] = mapped_column(Integer)
    file_size: Mapped[int] = mapped_column(Integer)
    has_transparency: Mapped[bool] = mapped_column(Boolean, default=False)
    sha256: Mapped[str] = mapped_column(String(64))
    approval_status: Mapped[str] = mapped_column(String(16), default="pending")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    destination_url: Mapped[str | None] = mapped_column(String(2048), nullable=True)
    uploaded_by: Mapped[str | None] = mapped_column(String(254), nullable=True)
    __table_args__ = (
        UniqueConstraint("family_id", "version", name="uq_creative_family_version"),
        CheckConstraint("approval_status in ('pending','approved','rejected')", name="ck_creative_approval"),
        Index("ix_creatives_filter", "approval_status", "asset_type"),
    )


CAMPAIGN_STORED = ("draft", "pending_approval", "approved", "paused", "rejected", "expired")


class Campaign(Base, Stamped):
    __tablename__ = "campaigns"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    application_id: Mapped[str] = mapped_column(ForeignKey("applications.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(160))
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    advertiser: Mapped[str] = mapped_column(String(120))
    start_time: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    end_time: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    timezone: Mapped[str] = mapped_column(String(64), default="UTC")  # how people read the times; stored as UTC
    status: Mapped[str] = mapped_column(String(20), default="draft")
    priority: Mapped[int] = mapped_column(Integer, default=5)
    is_direct: Mapped[bool] = mapped_column(Boolean, default=False)  # created by a one-click assignment
    last_effective_status: Mapped[str | None] = mapped_column(String(20), nullable=True)
    created_by: Mapped[str | None] = mapped_column(String(254), nullable=True)

    assignments: Mapped[list["Assignment"]] = relationship(back_populates="campaign")
    __table_args__ = (
        CheckConstraint("end_time is null or start_time is null or end_time > start_time", name="ck_campaign_window"),
        CheckConstraint("priority between 1 and 100", name="ck_campaign_priority"),
        CheckConstraint("status in ('draft','pending_approval','approved','paused','rejected','expired')", name="ck_campaign_status"),
        Index("ix_campaigns_app_status", "application_id", "status"),
    )


class Assignment(Base, Stamped):
    __tablename__ = "assignments"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    application_id: Mapped[str] = mapped_column(ForeignKey("applications.id", ondelete="CASCADE"), index=True)
    campaign_id: Mapped[str] = mapped_column(ForeignKey("campaigns.id", ondelete="CASCADE"))
    placement_id: Mapped[str] = mapped_column(ForeignKey("placements.id", ondelete="CASCADE"))
    creative_id: Mapped[str] = mapped_column(ForeignKey("creatives.id"))
    status: Mapped[str] = mapped_column(String(12), default="active")  # active | removed
    removed_reason: Mapped[str | None] = mapped_column(String(20), nullable=True)  # removed | replaced | rolled_back
    previous_creative_id: Mapped[str | None] = mapped_column(ForeignKey("creatives.id"), nullable=True)
    replaced_assignment_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    bulk_operation_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    created_by: Mapped[str | None] = mapped_column(String(254), nullable=True)
    removed_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    removed_by: Mapped[str | None] = mapped_column(String(254), nullable=True)

    campaign: Mapped[Campaign] = relationship(back_populates="assignments")
    placement: Mapped[Placement] = relationship()
    creative: Mapped[Creative] = relationship(foreign_keys=[creative_id])
    __table_args__ = (
        # one live row per campaign and placement; removed rows stay as history
        Index("uq_assignment_live", "campaign_id", "placement_id", unique=True,
              postgresql_where="status = 'active'", sqlite_where="status = 'active'"),
        Index("ix_assignments_placement", "placement_id", "status"),
        CheckConstraint("status in ('active','removed')", name="ck_assignment_status"),
    )


class ApprovalRecord(Base):
    __tablename__ = "approval_records"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    subject_type: Mapped[str] = mapped_column(String(16))  # creative | campaign
    subject_id: Mapped[str] = mapped_column(String(36), index=True)
    decision: Mapped[str] = mapped_column(String(16))  # submitted | approved | rejected
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    decided_by: Mapped[str] = mapped_column(String(254))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=_now)


class BulkOperation(Base):
    __tablename__ = "bulk_operations"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    application_id: Mapped[str] = mapped_column(ForeignKey("applications.id", ondelete="CASCADE"), index=True)
    operation_type: Mapped[str] = mapped_column(String(24), default="assign")
    creative_id: Mapped[str | None] = mapped_column(ForeignKey("creatives.id"), nullable=True)
    campaign_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    mode: Mapped[str] = mapped_column(String(20), default="all_or_nothing")
    status: Mapped[str] = mapped_column(String(16), default="applied")  # applied | partial | failed | rolled_back
    results: Mapped[list] = mapped_column(Json, default=list)
    created_by: Mapped[str] = mapped_column(String(254))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=_now)
    rolled_back_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    rolled_back_by: Mapped[str | None] = mapped_column(String(254), nullable=True)


class AuditLog(Base):
    __tablename__ = "audit_logs"
    id: Mapped[int] = mapped_column(BigInteger().with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=_now, index=True)
    actor_email: Mapped[str] = mapped_column(String(254))
    action: Mapped[str] = mapped_column(String(48), index=True)
    resource_type: Mapped[str] = mapped_column(String(24))
    resource_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    application_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    placement_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    campaign_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    bulk_operation_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    outcome: Mapped[str] = mapped_column(String(10), default="success")
    detail: Mapped[dict | None] = mapped_column(Json, nullable=True)


class AssetScan(Base):
    """What was found in an uploaded project zip. The zip itself is never stored; only previews and findings are kept."""
    __tablename__ = "asset_scans"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    application_id: Mapped[str] = mapped_column(ForeignKey("applications.id", ondelete="CASCADE"), index=True)
    file_name: Mapped[str] = mapped_column(String(255))
    project_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    summary: Mapped[dict] = mapped_column(Json, default=dict)
    assets: Mapped[list] = mapped_column(Json, default=list)
    warnings: Mapped[list] = mapped_column(Json, default=list)
    created_by: Mapped[str] = mapped_column(String(254))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=_now)
