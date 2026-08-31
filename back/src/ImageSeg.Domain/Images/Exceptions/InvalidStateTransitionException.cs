using ImageSeg.Domain.Images.Enums;

namespace ImageSeg.Domain.Images.Exceptions;

/// <summary>
/// Spec §2.4: any out-of-order transition attempt must throw and be logged. This is the
/// cheapest place to catch a duplicate or out-of-order write before it corrupts state.
/// </summary>
public sealed class InvalidStateTransitionException : Exception
{
    public Guid TaskId { get; }
    public ImageTaskState From { get; }
    public ImageTaskState To { get; }

    public InvalidStateTransitionException(Guid taskId, ImageTaskState from, ImageTaskState to)
        : base($"Invalid state transition for task {taskId}: {from} -> {to}.")
    {
        TaskId = taskId;
        From = from;
        To = to;
    }
}
