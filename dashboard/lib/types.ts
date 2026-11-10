export type Role = "viewer" | "editor" | "admin";
export interface User { id: string; email: string; name: string; role: Role }
export interface Page<T> { items: T[]; total: number; page: number; page_size: number }

export interface Application {
  id: string; app_key: string; name: string; description: string | null; category: string | null; platform: string;
  integration_enabled: boolean; ads_enabled: boolean; integration_status: "awaiting_connection" | "connected" | "stale";
  runtime_key_prefix: string; runtime_key_required: boolean; config_version: number; last_seen_at: string | null; last_seen_version: number | null;
  placement_count: number; active_placement_count: number; created_at: string; runtime_key?: string;
}
export interface Render { fit?: string; alignment?: string; background_color?: string | null; rendering_mode?: string; max_width?: number | null; max_height?: number | null; corner_radius?: number | null; ad_position?: string; ad_size?: number; ad_area?: string; ad_x?: number; ad_y?: number; ad_radius?: number }
export interface Placement {
  id: string; application_id: string; placement_key: string; name: string; description: string | null;
  supported_asset_types: string[]; supported_formats: string[]; aspect_ratio: number | null; aspect_tolerance: number;
  min_width: number | null; min_height: number | null; max_file_size_bytes: number; requires_transparency: boolean;
  render: Render; fallback: { kind?: string; ref?: string | null; storage_key?: string; width?: number; height?: number }; fallback_preview_url: string | null; is_active: boolean;
  /** "widget": an AdForgeImage the developer placed. "asset": a picture inside the app; "remote": a photo it loads from the internet (both found by scanning the zip; the ad goes on top). */
  integration: "widget" | "asset" | "remote"; asset_path: string | null; variants: Variant[];
}
export interface Variant { scale: number; width: number; height: number; path?: string }
export interface ScanAsset {
  path: string; file_name?: string; replaceable: boolean; reason: string | null; used: boolean | null; usage_count?: number;
  usages: { file: string; line: number; snippet: string; width?: number; height?: number; fit?: string }[];
  format?: string; width?: number; height?: number; variants?: Variant[]; has_transparency?: boolean; file_size?: number; kind?: string;
  remote?: boolean; name?: string; host?: string; preview_url?: string | null; thumbnail_url?: string | null; slot: { placement_id: string; placement_key: string; is_active: boolean } | null;
}
export interface AssetScan {
  id: string; application_id: string; file_name: string; project_name: string | null; created_by: string; created_at: string;
  summary: { images: number; used: number; unused: number; not_replaceable: number; source_files: number; remote?: number }; warnings: string[]; assets: ScanAsset[];
}
export interface Creative {
  id: string; family_id: string; version: number; name: string; description: string | null; advertiser: string; product_name: string | null;
  asset_type: string; file_format: string; width: number; height: number; file_size: number; has_transparency: boolean;
  approval_status: "pending" | "approved" | "rejected"; is_active: boolean; destination_url: string | null; url: string; thumbnail_url: string;
  uploaded_by: string | null; created_at: string;
}
export interface Campaign {
  id: string; application_id: string; name: string; description: string | null; advertiser: string; start_time: string | null; end_time: string | null;
  timezone: string; status: string; effective_status: string; priority: number; is_direct: boolean; assignment_count: number; created_by: string | null; created_at: string;
}
export interface CampaignRef { id: string; name: string; status: string; priority: number; start_time: string | null; end_time: string | null; is_direct: boolean }
export interface WorkspaceAssignment { assignment_id: string; state: string; creative: Creative; campaign: CampaignRef }
export interface WorkspaceCard {
  placement: Placement;
  status: "active" | "scheduled" | "pending" | "rejected" | "expired" | "fallback";
  effective: WorkspaceAssignment | null; assignments: WorkspaceAssignment[];
}
export interface Audit {
  id: number; created_at: string; actor_email: string; action: string; resource_type: string; resource_id: string | null;
  application_id: string | null; placement_id: string | null; campaign_id: string | null; bulk_operation_id: string | null;
  outcome: string; detail: Record<string, any> | null;
}
export interface BulkResult { placement_id: string; status: string; assignment_id: string | null; errors: { code: string; message: string }[]; warnings: { code: string; message: string }[] }
export interface BulkOperation { id: string; status: string; mode: string; results: BulkResult[]; created_at: string }
