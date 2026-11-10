import re
from datetime import datetime
from typing import Annotated, Generic, Literal, TypeVar

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .models import ASSET_TYPES

T = TypeVar("T")
AssetType = Literal[ASSET_TYPES]  # type: ignore[valid-type]
ImageFormat = Literal["png", "jpeg", "webp"]
KEY = r"^[a-z0-9][a-z0-9._-]{1,118}[a-z0-9]$"
Name = Annotated[str, Field(min_length=1, max_length=160)]


class Page(BaseModel, Generic[T]):
    items: list[T]
    total: int
    page: int
    page_size: int


class ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# ---------- auth ----------
class LoginIn(BaseModel):
    email: str
    password: str


class UserOut(ORM):
    id: str
    email: str
    name: str
    role: str


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut


# ---------- applications ----------
class ApplicationIn(BaseModel):
    app_key: str = Field(pattern=r"^[a-z0-9][a-z0-9_-]{2,62}[a-z0-9]$", description="Public application ID used by the app at runtime")
    name: Name
    description: str | None = Field(None, max_length=2000)
    category: str | None = Field(None, max_length=60)
    platform: str = Field("flutter", max_length=40)


class ApplicationUpdate(BaseModel):
    name: Name | None = None
    description: str | None = Field(None, max_length=2000)
    category: str | None = Field(None, max_length=60)
    platform: str | None = Field(None, max_length=40)


class IntegrationIn(BaseModel):
    enabled: bool


class ApplicationOut(ORM):
    id: str
    app_key: str
    name: str
    description: str | None
    category: str | None
    platform: str
    integration_enabled: bool = Field(description="Ads switch for the whole app. Off: every placement shows the app's own asset")
    ads_enabled: bool = True
    integration_status: str = "awaiting_connection"
    runtime_key_prefix: str
    runtime_key_required: bool = Field(False, description="Whether apps must send their runtime key (server setting RUNTIME_REQUIRE_KEY)")
    config_version: int
    last_seen_at: datetime | None
    last_seen_version: int | None
    placement_count: int = 0
    active_placement_count: int = 0
    created_at: datetime
    updated_at: datetime


class AssetScanOut(ORM):
    id: str
    application_id: str
    file_name: str
    project_name: str | None
    summary: dict
    warnings: list[str]
    assets: list[dict] = Field(default_factory=list, description="Every picture found: path, size, variants, transparency, kind, where the code uses it, preview")
    created_by: str
    created_at: datetime


class SlotsIn(BaseModel):
    paths: list[Annotated[str, Field(min_length=1, max_length=300)]] = Field(min_length=1, max_length=500,
                                                                             description="Asset paths from the scan to turn into ad slots")


class ApplicationCreated(ApplicationOut):
    runtime_key: str = Field(description="Shown once. Only needed when the server requires runtime keys (RUNTIME_REQUIRE_KEY).")


# ---------- placements ----------
class RenderSpec(BaseModel):
    fit: Literal["contain", "cover", "fill", "fitWidth", "fitHeight", "none", "scaleDown"] = "contain"
    alignment: Literal["center", "topLeft", "topCenter", "topRight", "centerLeft", "centerRight", "bottomLeft", "bottomCenter", "bottomRight"] = "center"
    background_color: str | None = Field(None, pattern=r"^#[0-9a-fA-F]{6}$")
    rendering_mode: Literal["image", "sprite", "texture", "background"] = "image"
    max_width: int | None = Field(None, gt=0, le=10000)
    max_height: int | None = Field(None, gt=0, le=10000)
    corner_radius: float | None = Field(None, ge=0, le=500)
    # Ad slots (pictures found in the app): where the ad sits on top of the picture, and how big it is
    ad_position: Literal["top_left", "top_right", "bottom_left", "bottom_right", "center", "bottom_strip", "custom"] = Field(
        "bottom_right", description="custom: wherever it was dragged to, see ad_x/ad_y")
    ad_size: float = Field(0.3, ge=0.05, le=1.0, description="Ad width as a share of the picture's width (bottom_strip: strip height as a share of its height)")
    ad_x: float = Field(0.5, ge=0, le=1, description="custom: the ad's centre, as a share of the picture's width (kept fully inside the picture)")
    ad_y: float = Field(0.5, ge=0, le=1, description="custom: the ad's centre, as a share of the picture's height")
    ad_radius: float = Field(0, ge=0, le=0.5, description="Rounded corners, as a share of the ad's shorter side: 0 square, 0.5 fully round")
    ad_area: Literal["whole", "safe"] = Field("whole", description="Place the ad within the whole picture, or within the centre part that stays "
                                                                  "visible however the app crops it (from a 4:5 box to a 2:1 banner)")


class FallbackSpec(BaseModel):
    kind: Literal["bundled_asset", "none"] = "bundled_asset"
    ref: str | None = Field(None, max_length=300, description="Where the app keeps its own default, e.g. assets/coffee_cup.png")


class PlacementIn(BaseModel):
    placement_key: str = Field(pattern=KEY, description="Unique within its application, e.g. home.coffee_cup")
    name: Name
    description: str | None = Field(None, max_length=2000)
    supported_asset_types: list[AssetType] = Field(min_length=1)
    supported_formats: list[ImageFormat] = Field(default_factory=lambda: ["png", "jpeg", "webp"], min_length=1)
    aspect_ratio: float | None = Field(None, gt=0.05, lt=20)
    aspect_tolerance: float = Field(0.05, ge=0, le=1)
    min_width: int | None = Field(None, ge=1, le=8192)
    min_height: int | None = Field(None, ge=1, le=8192)
    max_file_size_bytes: int = Field(2 * 1024 * 1024, ge=1024, le=8 * 1024 * 1024)
    requires_transparency: bool = False
    render: RenderSpec = Field(default_factory=RenderSpec)
    fallback: FallbackSpec = Field(default_factory=FallbackSpec)
    is_active: bool = True


class PlacementUpdate(BaseModel):
    name: Name | None = None
    description: str | None = Field(None, max_length=2000)
    supported_asset_types: list[AssetType] | None = Field(None, min_length=1)
    supported_formats: list[ImageFormat] | None = Field(None, min_length=1)
    aspect_ratio: float | None = Field(None, gt=0.05, lt=20)
    aspect_tolerance: float | None = Field(None, ge=0, le=1)
    min_width: int | None = Field(None, ge=1, le=8192)
    min_height: int | None = Field(None, ge=1, le=8192)
    max_file_size_bytes: int | None = Field(None, ge=1024, le=8 * 1024 * 1024)
    requires_transparency: bool | None = None
    render: RenderSpec | None = None
    fallback: FallbackSpec | None = None
    is_active: bool | None = None


class PlacementOut(ORM):
    id: str
    application_id: str
    placement_key: str
    name: str
    description: str | None
    supported_asset_types: list[str]
    supported_formats: list[str]
    aspect_ratio: float | None
    aspect_tolerance: float
    min_width: int | None
    min_height: int | None
    max_file_size_bytes: int
    requires_transparency: bool
    render: dict
    fallback: dict
    fallback_preview_url: str | None = None
    is_active: bool
    integration: str = "widget"
    asset_path: str | None = None
    variants: list[dict] = []
    created_at: datetime
    updated_at: datetime


# ---------- creatives ----------
class CreativeOut(ORM):
    id: str
    family_id: str
    version: int
    name: str
    description: str | None
    advertiser: str
    product_name: str | None
    asset_type: str
    file_format: str
    width: int
    height: int
    file_size: int
    has_transparency: bool
    sha256: str
    approval_status: str
    is_active: bool
    destination_url: str | None
    url: str = ""
    thumbnail_url: str = ""
    uploaded_by: str | None
    created_at: datetime
    updated_at: datetime
    compatibility: list[dict] | None = None  # filled when filtering "compatible with placement X"


class CreativeUpdate(BaseModel):
    name: Name | None = None
    description: str | None = Field(None, max_length=2000)
    advertiser: str | None = Field(None, min_length=1, max_length=120)
    product_name: str | None = Field(None, max_length=160)
    asset_type: AssetType | None = None
    destination_url: str | None = Field(None, max_length=2048)

    @field_validator("destination_url")
    @classmethod
    def _url(cls, v):
        return check_url(v)


class RejectIn(BaseModel):
    reason: str = Field(min_length=3, max_length=1000)


def check_url(v: str | None) -> str | None:
    if v in (None, ""):
        return None
    if not re.match(r"^https?://[^\s/$.?#][^\s]*$", v, re.I):
        raise ValueError("must be a full http(s) address, e.g. https://brand.example/product")
    return v


# ---------- campaigns ----------
class CampaignIn(BaseModel):
    application_id: str
    name: Name
    description: str | None = Field(None, max_length=2000)
    advertiser: str = Field(min_length=1, max_length=120)
    start_time: datetime | None = None
    end_time: datetime | None = None
    timezone: str = Field("UTC", max_length=64)
    priority: int = Field(5, ge=1, le=100)


class CampaignUpdate(BaseModel):
    name: Name | None = None
    description: str | None = Field(None, max_length=2000)
    advertiser: str | None = Field(None, min_length=1, max_length=120)
    start_time: datetime | None = None
    end_time: datetime | None = None
    timezone: str | None = Field(None, max_length=64)
    priority: int | None = Field(None, ge=1, le=100)


class CampaignOut(ORM):
    id: str
    application_id: str
    name: str
    description: str | None
    advertiser: str
    start_time: datetime | None
    end_time: datetime | None
    timezone: str
    status: str
    effective_status: str = ""
    priority: int
    is_direct: bool
    assignment_count: int = 0
    created_by: str | None
    created_at: datetime
    updated_at: datetime


class AssignmentIn(BaseModel):
    placement_id: str = Field(description="Placement id or placement key")
    creative_id: str


class AssignmentOut(ORM):
    id: str
    application_id: str
    campaign_id: str
    placement_id: str
    creative_id: str
    status: str
    removed_reason: str | None
    previous_creative_id: str | None
    bulk_operation_id: str | None
    created_by: str | None
    created_at: datetime
    state: str | None = None


class BulkAssignIn(BaseModel):
    placement_ids: list[str] = Field(min_length=1, max_length=200, description="Placement ids or keys")
    creative_id: str
    campaign_id: str | None = Field(None, description="Add to this campaign; leave empty for a direct assignment")
    start_time: datetime | None = None
    end_time: datetime | None = None
    timezone: str = "UTC"
    priority: int = Field(5, ge=1, le=100)
    name: str | None = Field(None, max_length=160)
    mode: Literal["all_or_nothing", "partial"] = "all_or_nothing"


class DirectAssignIn(BaseModel):
    creative_id: str
    campaign_id: str | None = Field(None, description="Add to this campaign; leave empty for a direct assignment")
    start_time: datetime | None = None
    end_time: datetime | None = None
    timezone: str = "UTC"
    priority: int = Field(5, ge=1, le=100)
    name: str | None = Field(None, max_length=160)


class BulkOperationOut(ORM):
    id: str
    application_id: str
    operation_type: str
    creative_id: str | None
    campaign_id: str | None
    mode: str
    status: str
    results: list
    created_by: str
    created_at: datetime
    rolled_back_at: datetime | None


class AuditOut(ORM):
    id: int
    created_at: datetime
    actor_email: str
    action: str
    resource_type: str
    resource_id: str | None
    application_id: str | None
    placement_id: str | None
    campaign_id: str | None
    bulk_operation_id: str | None
    outcome: str
    detail: dict | None


# ---------- runtime ----------
class RuntimeCreative(BaseModel):
    creative_id: str
    version: int
    url: str
    thumbnail_url: str
    width: int
    height: int
    format: str
    sha256: str
    has_transparency: bool
    advertiser: str
    product_name: str | None
    destination_url: str | None
    campaign_id: str
    campaign_status: str
    valid_from: str | None
    valid_until: str | None


class RuntimePlacement(BaseModel):
    placement_id: str
    integration: Literal["widget", "asset", "remote"] = "widget"
    asset_path: str | None = Field(None, description="Ad slots: the app's picture (bundled path, or web address) the ad is drawn on")
    asset_keys: list[str] | None = Field(None, description="Bundled pictures only: every file name the app may load for it (one per screen density)")
    render: dict
    fallback: dict
    creative: RuntimeCreative | None


class RuntimeConfig(BaseModel):
    schema_version: int
    application_id: str
    config_version: int
    server_time: str
    ttl_seconds: int
    next_change_at: str | None
    ads_enabled: bool = Field(True, description="False when ads are stopped for the whole application: show every original")
    max_stale_seconds: int = Field(description="If the app can't refresh for this long, it stops showing ads until it can")
    placements: list[RuntimePlacement]
