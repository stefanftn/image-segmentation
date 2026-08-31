namespace ImageSeg.Domain.Images.Enums;

/// <summary>
/// Which sidecar capability a task requests (spec §0).
///
/// - <c>Segment</c>: automatic wall mask via a fixed, mode-selected model (POST /segment on
///   the sidecar). <see cref="Entities.ImageTask.Mode"/> is required for this operation.
/// - <c>Regions</c>: SAM-based "label map" for interactive, frontend-driven region selection
///   (POST /regions on the sidecar) — no mode. The frontend composites masks itself from the
///   label map plus a set of region ids; see <see cref="MaskGroups.Entities.MaskGroup"/> for
///   how a saved selection is persisted.
/// </summary>
public enum ImageOperation
{
    Segment = 0,
    Regions = 1
}
