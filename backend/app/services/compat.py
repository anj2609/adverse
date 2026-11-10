from ..models import Creative, Placement


def compat_problems(p: Placement, c: Creative) -> list[dict]:
    """Why this creative can't be rendered in this placement. Empty list = compatible."""
    out: list[dict] = []

    def add(code: str, message: str) -> None:
        out.append({"code": code, "message": message})

    if p.supported_asset_types and c.asset_type not in p.supported_asset_types:
        add("asset_type", f"Asset type '{c.asset_type}' is not accepted here (accepts {', '.join(p.supported_asset_types)})")
    if p.supported_formats and c.file_format not in p.supported_formats:
        add("format", f"{c.file_format.upper()} is not accepted here (accepts {', '.join(f.upper() for f in p.supported_formats)})")
    if c.file_size > p.max_file_size_bytes:
        add("file_size", f"File is {c.file_size // 1024} KB; this placement allows {p.max_file_size_bytes // 1024} KB")
    if p.min_width and c.width < p.min_width:
        add("min_width", f"Width {c.width}px is below the minimum {p.min_width}px")
    if p.min_height and c.height < p.min_height:
        add("min_height", f"Height {c.height}px is below the minimum {p.min_height}px")
    if p.integration in ("asset", "remote"):
        return out  # the ad is drawn on top of the app's own picture at a chosen spot and size: any ad shape fits
    if p.aspect_ratio:
        got = c.width / c.height
        if abs(got - p.aspect_ratio) / p.aspect_ratio > p.aspect_tolerance:
            add("aspect_ratio", f"Shape {c.width}×{c.height} ({got:.2f}:1) does not match the required {p.aspect_ratio:.2f}:1")
    if p.requires_transparency and not c.has_transparency:
        add("transparency", "This placement needs an image with a transparent background")
    return out
