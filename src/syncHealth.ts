/** A partial Firestore listener set must not be presented as fully connected. */
export function isCloudRealtimeConnected(online: boolean, liveSubscriptionCount: number, requiredSubscriptionCount: number) {
  return online && requiredSubscriptionCount > 0 && liveSubscriptionCount >= requiredSubscriptionCount;
}
