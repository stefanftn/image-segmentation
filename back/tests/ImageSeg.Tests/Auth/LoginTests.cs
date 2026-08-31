using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using ImageSeg.Web.Identity;
using Microsoft.AspNetCore.Mvc;
using Xunit;

namespace ImageSeg.Tests.Auth;

public sealed class LoginTests : IClassFixture<TestWebApplicationFactory>, IAsyncLifetime
{
    private const string Password = "Str0ng!Pass";

    private readonly TestWebApplicationFactory _factory;
    private HttpClient _client = default!;

    public LoginTests(TestWebApplicationFactory factory) => _factory = factory;

    public async Task InitializeAsync()
    {
        await _factory.InitializeDatabaseAsync();
        _client = _factory.CreateClient();
    }

    public Task DisposeAsync() => Task.CompletedTask;

    private static string NewEmail() => $"{Guid.NewGuid():N}@example.com";

    private async Task<string> RegisterAsync(string email, string password = Password)
    {
        var response = await _client.PostAsJsonAsync("/api/auth/register", new RegisterRequest(email, password));
        response.EnsureSuccessStatusCode();
        return email;
    }

    // ---- happy path ------------------------------------------------------------------

    [Fact]
    public async Task Login_WithCorrectCredentials_ReturnsAccessToken()
    {
        var email = await RegisterAsync(NewEmail());

        var response = await _client.PostAsJsonAsync("/api/auth/login", new LoginRequest(email, Password));

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await response.Content.ReadFromJsonAsync<AuthTokenResponse>();
        body!.Token.Should().NotBeNullOrWhiteSpace();
    }

    // ---- failure cases -----------------------------------------------------------------

    [Fact]
    public async Task Login_WithWrongPassword_ReturnsUnauthorized()
    {
        var email = await RegisterAsync(NewEmail());

        var response = await _client.PostAsJsonAsync("/api/auth/login", new LoginRequest(email, "TotallyWrong!1"));

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Login_WithNoSuchAccount_ReturnsUnauthorized()
    {
        var response = await _client.PostAsJsonAsync("/api/auth/login", new LoginRequest(NewEmail(), Password));

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Login_DoesNotRevealWhetherTheAccountExists()
    {
        // A different status code or message for "no such user" vs "wrong password" would let
        // an attacker enumerate registered emails one guess at a time. Both must look
        // identical from the outside.
        var email = await RegisterAsync(NewEmail());

        var wrongPassword = await _client.PostAsJsonAsync("/api/auth/login", new LoginRequest(email, "Wrong!Pass1"));
        var noSuchAccount = await _client.PostAsJsonAsync("/api/auth/login", new LoginRequest(NewEmail(), "Wrong!Pass1"));

        wrongPassword.StatusCode.Should().Be(noSuchAccount.StatusCode);

        var wrongPasswordBody = await wrongPassword.Content.ReadFromJsonAsync<ProblemDetails>();
        var noSuchAccountBody = await noSuchAccount.Content.ReadFromJsonAsync<ProblemDetails>();
        wrongPasswordBody!.Detail.Should().Be(noSuchAccountBody!.Detail);
    }

    [Fact]
    public async Task Login_AfterFiveFailedAttempts_LocksOutTheAccountEvenWithTheCorrectPassword()
    {
        // Identity's default Lockout.MaxFailedAccessAttempts is 5, active by default for new
        // users (Lockout.AllowedForNewUsers = true) - Program.cs never overrides either.
        var email = await RegisterAsync(NewEmail());

        for (var attempt = 0; attempt < 5; attempt++)
            await _client.PostAsJsonAsync("/api/auth/login", new LoginRequest(email, "Wrong!Pass1"));

        var response = await _client.PostAsJsonAsync("/api/auth/login", new LoginRequest(email, Password));

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        var body = await response.Content.ReadFromJsonAsync<ProblemDetails>();
        body!.Detail.Should().Contain("locked",
            "the account should now be locked out, not merely rejecting this one attempt");
    }
}
