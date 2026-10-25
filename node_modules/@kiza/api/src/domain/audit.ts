import type { AuditEntry } from '@kiza/shared';
import type { Actor, Ctx } from '../context';
import { all, run } from '../db/db';

/**
 * Append-only audit trail. Write it in the same transaction as the change it describes.
 * Keep personal data out of `details` — reference ids instead.
 */
export function audit(
  ctx: Ctx,
  actor: Actor,
  action: string,
  entityType: string,
  entityId: string | null,
  details?: Record<string, unknown>,
): void {
  run(
    ctx.db,
    `INSERT INTO audit_log (at, actor_type, actor_id, action, entity_type, entity_id, details)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      ctx.clock().toISOString(),
      actor.type,
      actor.id,
      action,
      entityType,
      entityId,
      details ? JSON.stringify(details) : null,
    ],
  );
}

export function listAudit(ctx: Ctx, opts: { limit: number; beforeId?: number; entityId?: string }): AuditEntry[] {
  const rows = all<{
    id: number;
    at: string;
    actor_type: string;
    actor_name: string | null;
    action: string;
    entity_type: string;
    entity_id: string | null;
    details: string | null;
  }>(
    ctx.db,
    `SELECT a.id, a.at, a.actor_type, COALESCE(s.full_name, st.student_number) AS actor_name,
            a.action, a.entity_type, a.entity_id, a.details
       FROM audit_log a
       LEFT JOIN staff s ON a.actor_type = 'staff' AND s.id = a.actor_id
       LEFT JOIN students st ON a.actor_type = 'student' AND st.id = a.actor_id
      WHERE (:before IS NULL OR a.id < :before)
        AND (:entity IS NULL OR a.entity_id = :entity)
      ORDER BY a.id DESC
      LIMIT :limit`,
    { before: opts.beforeId ?? null, entity: opts.entityId ?? null, limit: opts.limit },
  );
  return rows.map((r) => ({
    id: r.id,
    at: r.at,
    actorType: r.actor_type,
    actorName: r.actor_name,
    action: r.action,
    entityType: r.entity_type,
    entityId: r.entity_id,
    details: r.details ? JSON.parse(r.details) : null,
  }));
}
