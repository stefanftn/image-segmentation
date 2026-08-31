using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using FluentAssertions;
using ImageSeg.Web.Identity;
using Xunit;

namespace ImageSeg.Tests.Auth;

/// <summary>
/// Not an auth-endpoint test itself, but closes the loop this project actually needs closed:
/// a token from /api/auth/register or /login is only useful if it actually authorizes a real
/// [Authorize] endpoint elsewhere in the app. This is the exact category of bug hit twice in
/// this project's history (default auth scheme pointed at an unregistered handler; an
/// unconditionally-registered Google scheme crashing every request) - both would show up here
/// as a working-looking token that mysteriously still gets 401'd everywhere.
/// </summary>
public sealed class ProtectedEndpointTests : IClassFixture<TestWebApplicationFactory>, IAsyncLifetime
{
    private readonly TestWebApplicationFactory _factory;
    private HttpClient _client = default!;

    public ProtectedEndpointTests(TestWebApplicationFactory factory) => _factory = factory;

    public async Task InitializeAsync()
    {
        await _factory.InitializeDatabaseAsync();
        _client = _factory.CreateClient();
    }

    public Task DisposeAsync() => Task.CompletedTask;

    [Fact]
    public async Task ListImages_WithoutAToken_ReturnsUnauthorized()
    {
        var response = await _client.GetAsync("/api/images");

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task ListImages_WithAGarbageToken_ReturnsUnauthorized()
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, "/api/images");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", "not-a-real-jwt");

        var response = await _client.SendAsync(request);

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task ListImages_WithAValidTokenFromRegister_ReturnsOk()
    {
        var registerResponse = await _client.PostAsJsonAsync("/api/auth/register",
            new RegisterRequest($"{Guid.NewGuid():N}@example.com", "Str0ng!Pass"));
        var token = (await registerResponse.Content.ReadFromJsonAsync<AuthTokenResponse>())!.Token;

        using var request = new HttpRequestMessage(HttpMethod.Get, "/api/images");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);

        var response = await _client.SendAsync(request);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
    }
}
