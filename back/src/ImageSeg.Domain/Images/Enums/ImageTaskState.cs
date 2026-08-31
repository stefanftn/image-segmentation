namespace ImageSeg.Domain.Images.Enums;

/// <summary>
/// Lifecycle of a segmentation task (spec §2.1 / §2.4). Persisted as a string (see
/// AppDbContext in Infrastructure) so the poller raw SQL and the sweeper ExecuteUpdate
/// predicate stay readable.
/// </summary>
public enum ImageTaskState
{
    Pending = 0,
    Preprocessing = 1,
    Processing = 2,
    Completed = 3,
    Failed = 4
}
