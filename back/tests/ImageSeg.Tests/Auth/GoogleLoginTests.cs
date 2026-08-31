using System.Net;
using FluentAssertions;
using Xunit;

namespace ImageSeg.Tests.Auth;

/// <summary>
/// Regression test for a real bug this project hit: with Authentication:Google:ClientId/
/// ClientSecret unset (as they are in TestWebApplicationFactory, matching a fresh/
/// unconfigured deployment), calling Challenge() for a scheme that was never registered
/// crashed with an unhandled 500. The fix (AuthController.IsGoogleConfigured()) is what this
/// asserts stays true.
/// </summary>
public sealed class GoogleLoginTests : IClassFixture<TestWebApplicationFactory>, IAsyncLifetime
{
    private readonly TestWebApplicationFactory _factory;
    private HttpClient _client = default!;

    public GoogleLoginTests(TestWebApplicationFactory factory) => _factory = factory;

    public async Task InitializeAsync()
    {
        await _factory.InitializeDatabaseAsync();
        _client = _factory.CreateClient();
    }

    public Task DisposeAsync() => Task.CompletedTask;

    [Fact]
    public async Task ExternalLoginGoogle_WhenNotConfigured_ReturnsNotFound_NotAServerError()
    {
        var response = await _client.GetAsync("/api/auth/google/login?returnUrl=/");

        response.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }
}
