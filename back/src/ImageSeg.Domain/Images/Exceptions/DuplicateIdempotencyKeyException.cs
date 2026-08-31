namespace ImageSeg.Domain.Images.Exceptions;

/// <summary>
/// Thrown by <c>IImageTaskRepository.AddAsync</c> when a concurrent request already claimed
/// the same <c>IdempotencyKey</c> (spec §2.3's unique filtered index) between the service's own
/// pre-check and the insert. The caller (ImageTaskService) treats this as "someone else already
/// won" and returns the winning task instead of an error.
/// </summary>
public sealed class DuplicateIdempotencyKeyException : Exception
{
    public string IdempotencyKey { get; }

    public DuplicateIdempotencyKeyException(string idempotencyKey)
        : base($"IdempotencyKey '{idempotencyKey}' was already used by another task.")
    {
        IdempotencyKey = idempotencyKey;
    }
}
