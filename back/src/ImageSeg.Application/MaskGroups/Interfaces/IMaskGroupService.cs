namespace ImageSeg.Application.MaskGroups.Interfaces;

public sealed record MaskGroupDto(Guid Id, Guid ImageTaskId, string Name, IReadOnlyList<int> RegionIds, DateTime CreatedAtUtc, DateTime UpdatedAtUtc);

/// <summary>
/// Spec §1, §8. Every method is owner-scoped: the caller passes the requesting identity's id,
/// and a task that does not exist or is not owned by that caller is treated identically (404
/// at the controller, not 403) - a non-owner must not be able to learn a task exists.
/// </summary>
public interface IMaskGroupService
{
    /// <summary>
    /// Throws <see cref="KeyNotFoundException"/> if the task does not exist or is not owned by
    /// <paramref name="ownerId"/>; throws <see cref="InvalidOperationException"/> if the task is
    /// not a Completed Regions task (only those have a label map to select against).
    /// </summary>
    Task<MaskGroupDto> CreateAsync(Guid imageTaskId, string ownerId, string name, IReadOnlyList<int> regionIds, CancellationToken ct);

    Task<MaskGroupDto?> UpdateAsync(Guid imageTaskId, Guid groupId, string ownerId, string name, IReadOnlyList<int> regionIds, CancellationToken ct);

    Task<bool> DeleteAsync(Guid imageTaskId, Guid groupId, string ownerId, CancellationToken ct);

    /// <summary>Null return means "not found or not owned" - collapsed on purpose, see class remarks.</summary>
    Task<IReadOnlyList<MaskGroupDto>?> ListAsync(Guid imageTaskId, string ownerId, CancellationToken ct);
}
