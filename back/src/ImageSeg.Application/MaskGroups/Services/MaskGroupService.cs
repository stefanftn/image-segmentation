using ImageSeg.Application.MaskGroups.Interfaces;
using ImageSeg.Domain.Images.Enums;
using ImageSeg.Domain.Images.Interfaces;
using ImageSeg.Domain.MaskGroups.Entities;
using ImageSeg.Domain.MaskGroups.Interfaces;

namespace ImageSeg.Application.MaskGroups.Services;

public sealed class MaskGroupService : IMaskGroupService
{
    private readonly IMaskGroupRepository _groups;
    private readonly IImageTaskRepository _tasks;
    private readonly TimeProvider _clock;

    public MaskGroupService(IMaskGroupRepository groups, IImageTaskRepository tasks, TimeProvider clock)
    {
        _groups = groups;
        _tasks = tasks;
        _clock = clock;
    }

    public async Task<MaskGroupDto> CreateAsync(Guid imageTaskId, string ownerId, string name, IReadOnlyList<int> regionIds, CancellationToken ct)
    {
        var task = await _tasks.GetByIdAsync(imageTaskId, ct);
        if (task is null || !string.Equals(task.OwnerId, ownerId, StringComparison.Ordinal))
            throw new KeyNotFoundException($"ImageTask {imageTaskId} was not found for this owner.");

        // Only a completed Regions task has a label map to select region ids against - a
        // Segment task has no such concept, and an in-flight Regions task has no result yet.
        if (task.Operation != ImageOperation.Regions)
            throw new InvalidOperationException("Mask groups can only be created for Operation=Regions tasks.");
        if (task.State != ImageTaskState.Completed)
            throw new InvalidOperationException("The task must be Completed before saving a region selection.");

        var group = MaskGroup.Create(imageTaskId, name, regionIds, _clock.GetUtcNow().UtcDateTime);
        await _groups.AddAsync(group, ct);
        await _groups.SaveChangesAsync(ct);

        return ToDto(group);
    }

    public async Task<MaskGroupDto?> UpdateAsync(Guid imageTaskId, Guid groupId, string ownerId, string name, IReadOnlyList<int> regionIds, CancellationToken ct)
    {
        var task = await _tasks.GetByIdAsync(imageTaskId, ct);
        if (task is null || !string.Equals(task.OwnerId, ownerId, StringComparison.Ordinal))
            return null;

        var group = await _groups.GetAsync(imageTaskId, groupId, ct);
        if (group is null) return null;

        group.Update(name, regionIds, _clock.GetUtcNow().UtcDateTime);
        await _groups.SaveChangesAsync(ct);

        return ToDto(group);
    }

    public async Task<bool> DeleteAsync(Guid imageTaskId, Guid groupId, string ownerId, CancellationToken ct)
    {
        var task = await _tasks.GetByIdAsync(imageTaskId, ct);
        if (task is null || !string.Equals(task.OwnerId, ownerId, StringComparison.Ordinal))
            return false;

        return await _groups.DeleteAsync(imageTaskId, groupId, ct);
    }

    public async Task<IReadOnlyList<MaskGroupDto>?> ListAsync(Guid imageTaskId, string ownerId, CancellationToken ct)
    {
        var task = await _tasks.GetByIdAsync(imageTaskId, ct);
        if (task is null || !string.Equals(task.OwnerId, ownerId, StringComparison.Ordinal))
            return null;

        var groups = await _groups.ListAsync(imageTaskId, ct);
        return groups.Select(ToDto).ToList();
    }

    private static MaskGroupDto ToDto(MaskGroup g) =>
        new(g.Id, g.ImageTaskId, g.Name, g.DeserializeRegionIds(), g.CreatedAtUtc, g.UpdatedAtUtc);
}
