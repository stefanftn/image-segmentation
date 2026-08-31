using ImageSeg.Application.Images.Interfaces;
using Microsoft.AspNetCore.SignalR;

namespace ImageSeg.Web.Images.Hubs;

/// <summary>
/// Implements Application's <see cref="ITaskStatusNotifier"/> using the SignalR hub context,
/// which is an ASP.NET Core Web concern - this is the one small adapter class that lets
/// ImageTaskService (Application) trigger a push without Application ever referencing
/// Microsoft.AspNetCore.SignalR or Web. Registered in Program.cs alongside everything else.
/// </summary>
public sealed class SignalRTaskStatusNotifier : ITaskStatusNotifier
{
    private readonly IHubContext<TaskStatusHub> _hubContext;

    public SignalRTaskStatusNotifier(IHubContext<TaskStatusHub> hubContext) => _hubContext = hubContext;

    public Task NotifyStatusChangedAsync(TaskStatusSnapshot snapshot, CancellationToken ct)
        => _hubContext.Clients.Group(TaskStatusHub.GroupName(snapshot.RequestId))
            .SendAsync("StatusChanged", snapshot, ct);
}
