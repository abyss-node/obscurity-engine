import type { Session } from "./session";

/**
 * Gates the save/dismiss action UI. Per the pinned contract, discovery
 * responses carry a top-level `persistence: bool` and per-item nullable
 * `rec_id`; when persistence is false, rec_id is null, or there's no
 * session, the new UI must not render at all (never a silently no-op
 * button).
 */
export function canPersistActions(
  session: Session | null,
  persistence: boolean | undefined,
  recId: string | null | undefined
): boolean {
  return session !== null && persistence === true && !!recId;
}

/**
 * Gates click_listen/share beacons — these fire whenever a rec_id exists,
 * with no auth requirement (anonymous events are allowed for these types).
 */
export function canFireRecEvent(recId: string | null | undefined): boolean {
  return !!recId;
}
