using ImageSeg.Domain.Images.Entities;

namespace ImageSeg.Application.Images.Interfaces;

/// <summary>
/// Spec §5. SignalR replaces the old Redis read-cache: after every successful state write,
/// <see cref="Services.ImageTaskService"/> pushes the new snapshot to every client that joined
/// this task's group. The actual <c>IHubContext&lt;TaskStatusHub&gt;</c> is an ASP.NET Core Web
/// concern, so this interface is the seam - implemented in ImageSeg.Web (where the hub lives)
/// and injected here, keeping the dependency rule (Application never references Web) intact.
/// </summary>
public interface ITaskStatusNotifier
{
    Task NotifyStatusChangedAsync(TaskStatusSnapshot snapshot, CancellationToken ct);
}

/// <summary>Everything a client needs to render a status update, pushed as-is over SignalR.</summary>
public sealed record TaskStatusSnapshot(
    Guid RequestId,
    string Operation,
    string? Mode,
    string State,
    DateTime UpdatedAtUtc,
    bool IsTerminal,
    string? ErrorMessage,
    string? ResultUrl)
{
    public static TaskStatusSnapshot From(ImageTask task) => new(
        task.Id,
        task.Operation.ToString(),
        task.Mode,
        task.State.ToString(),
        task.UpdatedAtUtc,
        Domain.Images.Entities.ImageTaskStateMachine.IsTerminal(task.State),
        task.ErrorMessage,
        task.State == Domain.Images.Enums.ImageTaskState.Completed ? $"/api/images/{task.Id}/result" : null);
}
