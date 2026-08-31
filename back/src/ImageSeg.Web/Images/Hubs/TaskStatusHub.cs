using Microsoft.AspNetCore.SignalR;

namespace ImageSeg.Web.Images.Hubs;

/// <summary>
/// Spec §5. Clients call <see cref="JoinTaskGroup"/> after connecting to join a per-task group;
/// <see cref="ImageTaskService"/> (Application) pushes "StatusChanged" to that group after every
/// successful state write via <see cref="SignalRTaskStatusNotifier"/>.
///
/// One process, no backplane: a backplane like Redis would only be required for multiple Web
/// instances sharing hub state, which is out of scope at this system's target scale (spec §5) -
/// but IHubContext&lt;TaskStatusHub&gt; is exactly the seam a backplane would slot behind if that
/// ever changes, so nothing here needs to change to add one later.
/// </summary>
public sealed class TaskStatusHub : Hub
{
    public async Task JoinTaskGroup(Guid taskId)
    {
        await Groups.AddToGroupAsync(Context.ConnectionId, GroupName(taskId));
    }

    public async Task LeaveTaskGroup(Guid taskId)
    {
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, GroupName(taskId));
    }

    public static string GroupName(Guid taskId) => $"task:{taskId:N}";
}
