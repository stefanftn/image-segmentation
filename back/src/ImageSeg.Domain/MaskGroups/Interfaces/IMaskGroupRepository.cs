using ImageSeg.Domain.MaskGroups.Entities;

namespace ImageSeg.Domain.MaskGroups.Interfaces;

public interface IMaskGroupRepository
{
    Task AddAsync(MaskGroup group, CancellationToken ct);

    Task<MaskGroup?> GetAsync(Guid imageTaskId, Guid groupId, CancellationToken ct);

    Task<IReadOnlyList<MaskGroup>> ListAsync(Guid imageTaskId, CancellationToken ct);

    Task SaveChangesAsync(CancellationToken ct);

    /// <summary>Returns true if a row was deleted.</summary>
    Task<bool> DeleteAsync(Guid imageTaskId, Guid groupId, CancellationToken ct);

    /// <summary>Deletes every group for a task in one statement (spec §8, DELETE /api/images/{id}).</summary>
    Task DeleteAllForTaskAsync(Guid imageTaskId, CancellationToken ct);
}
