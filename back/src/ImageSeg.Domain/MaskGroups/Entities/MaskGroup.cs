using System.Text.Json;

namespace ImageSeg.Domain.MaskGroups.Entities;

/// <summary>
/// A saved, named selection of SAM region ids for a <c>Regions</c> ImageTask.
///
/// Deliberately stores only the region id list, never a rendered mask: the frontend already
/// derives a mask from the task's label map (its ResultFilePath) plus a set of region ids
/// entirely client-side, so persisting a second, derived PNG here would just be a second thing
/// that could drift out of sync with the id list. Re-deriving from the ids on every load is
/// cheap and always correct.
///
/// One ImageTask can have many groups - that is the "workspace" a user resumes when they
/// reopen an image: every group they had previously carved out, loaded back at once.
/// </summary>
public class MaskGroup
{
    public Guid Id { get; private set; } = Guid.NewGuid();

    /// <summary>
    /// No formal FK to ImageTasks - application-enforced (spec §2.2), same reasoning as the
    /// rest of this schema: independent writes without EF FK-ordering concerns. Ownership and
    /// existence are enforced in MaskGroupService, not the database.
    /// </summary>
    public Guid ImageTaskId { get; private set; }

    public string Name { get; private set; } = default!;

    /// <summary>JSON array of region ids from the label map, e.g. "[3,7,12]".</summary>
    public string RegionIdsJson { get; private set; } = "[]";

    public DateTime CreatedAtUtc { get; private set; }

    public DateTime UpdatedAtUtc { get; private set; }

    private MaskGroup() { } // EF

    public static MaskGroup Create(Guid imageTaskId, string name, IReadOnlyList<int> regionIds, DateTime utcNow)
        => new()
        {
            Id = Guid.NewGuid(),
            ImageTaskId = imageTaskId,
            Name = name,
            RegionIdsJson = JsonSerializer.Serialize(regionIds),
            CreatedAtUtc = utcNow,
            UpdatedAtUtc = utcNow
        };

    public void Update(string name, IReadOnlyList<int> regionIds, DateTime utcNow)
    {
        Name = name;
        RegionIdsJson = JsonSerializer.Serialize(regionIds);
        UpdatedAtUtc = utcNow;
    }

    public IReadOnlyList<int> DeserializeRegionIds()
        => JsonSerializer.Deserialize<List<int>>(RegionIdsJson) ?? new List<int>();
}
