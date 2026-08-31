using ImageSeg.Domain.Images.Enums;

namespace ImageSeg.Domain.Images.Entities;

/// <summary>
/// Single source of truth for legal transitions (spec §2.4):
/// Pending -&gt; Preprocessing -&gt; Processing -&gt; Completed, and any non-terminal state -&gt; Failed.
///
/// Exposed as *allowed predecessors* rather than a boolean check because
/// <c>IImageTaskRepository.UpdateStateAsync</c> (the EF <c>ExecuteUpdateAsync</c>-based writer,
/// spec §2.4) needs to express the guard as a SQL WHERE clause instead of loading the entity
/// first.
/// </summary>
public static class ImageTaskStateMachine
{
    private static readonly IReadOnlyDictionary<ImageTaskState, ImageTaskState[]> Predecessors =
        new Dictionary<ImageTaskState, ImageTaskState[]>
        {
            [ImageTaskState.Pending]       = Array.Empty<ImageTaskState>(), // initial state only
            [ImageTaskState.Preprocessing] = new[] { ImageTaskState.Pending },
            [ImageTaskState.Processing]    = new[] { ImageTaskState.Preprocessing },
            [ImageTaskState.Completed]     = new[] { ImageTaskState.Processing },
            [ImageTaskState.Failed]        = new[] { ImageTaskState.Pending, ImageTaskState.Preprocessing, ImageTaskState.Processing }
        };

    public static ImageTaskState[] AllowedPredecessors(ImageTaskState target) => Predecessors[target];

    public static bool CanTransition(ImageTaskState from, ImageTaskState to)
        => Predecessors[to].Contains(from);

    public static bool IsTerminal(ImageTaskState state)
        => state is ImageTaskState.Completed or ImageTaskState.Failed;
}
