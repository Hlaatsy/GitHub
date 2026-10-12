import { type PrismaClient, type TemplateStatus } from '@prisma/client';
import { z } from 'zod';
import { type Logger } from '../../lib/logger';
import { type WhatsAppService } from '../WhatsAppService';
import { type TemplateDefinition } from './definitions';
import { toGraphTemplate, validateTemplate } from './validate';

const KNOWN_STATUSES: ReadonlySet<string> = new Set(['PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED', 'IN_APPEAL']);

export function toTemplateStatus(value: string): TemplateStatus {
  const upper = value.toUpperCase();
  return (KNOWN_STATUSES.has(upper) ? upper : 'OTHER') as TemplateStatus;
}

export type SubmitOutcome =
  | { name: string; result: 'submitted'; status: TemplateStatus; categoryChanged: boolean }
  | { name: string; result: 'skipped'; status: TemplateStatus }
  | { name: string; result: 'invalid'; problems: string[] }
  | { name: string; result: 'failed'; error: string };

/** Meta's `message_template_status_update` webhook value. */
const StatusUpdateSchema = z
  .object({
    event: z.string().min(1).max(40),
    message_template_id: z.union([z.string(), z.number()]).transform(String),
    message_template_name: z.string().min(1).max(512),
    message_template_language: z.string().min(2).max(15),
    reason: z.string().max(200).nullish(),
  })
  .passthrough();

/**
 * Maps the app's template definitions into Meta's approval process for one
 * WhatsApp Business Account: validate locally, submit what is missing, and
 * track Meta's decision (via sync or the status webhook).
 */
export class TemplateService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly whatsapp: WhatsAppService,
    private readonly logger: Logger,
  ) {}

  /** Submits every definition not already approved or under review. Safe to re-run. */
  async submitMissing(wabaId: string, definitions: readonly TemplateDefinition[]): Promise<SubmitOutcome[]> {
    const outcomes: SubmitOutcome[] = [];
    for (const def of definitions) {
      const problems = validateTemplate(def);
      if (problems.length > 0) {
        outcomes.push({ name: def.name, result: 'invalid', problems });
        continue;
      }

      const existing = await this.prisma.messageTemplate.findUnique({
        where: { wabaId_name_language: { wabaId, name: def.name, language: def.language } },
      });
      // Rejected templates are resubmitted after the definition is fixed; anything else is left to Meta.
      if (existing && existing.status !== 'REJECTED') {
        outcomes.push({ name: def.name, result: 'skipped', status: existing.status });
        continue;
      }

      try {
        const created = await this.whatsapp.createTemplate(wabaId, toGraphTemplate(def));
        const status = toTemplateStatus(created.status);
        const categoryChanged = created.category.toUpperCase() !== def.category;
        await this.upsert(wabaId, def, { status, category: created.category.toUpperCase(), metaTemplateId: created.id, rejectedReason: null });
        if (categoryChanged) {
          this.logger.warn({ wabaId, template: def.name, requested: def.category, assigned: created.category }, 'Meta changed the template category; it will be billed at that rate');
        }
        outcomes.push({ name: def.name, result: 'submitted', status, categoryChanged });
      } catch (error) {
        // The usual cause is a template that already exists in Meta (created in
        // WhatsApp Manager, or a lost response). Adopt its real state if so.
        const synced = await this.sync(wabaId, [def]).catch(() => 0);
        const row =
          synced > 0
            ? await this.prisma.messageTemplate.findUnique({
                where: { wabaId_name_language: { wabaId, name: def.name, language: def.language } },
              })
            : null;
        outcomes.push(
          row ? { name: def.name, result: 'skipped', status: row.status } : { name: def.name, result: 'failed', error: (error as Error).message },
        );
      }
    }
    return outcomes;
  }

  /** Pulls Meta's current state for the given definitions. */
  async sync(wabaId: string, definitions: readonly TemplateDefinition[]): Promise<number> {
    const wanted = new Map(definitions.map((def) => [`${def.name}|${def.language}`, def]));
    let updated = 0;
    for (const remote of await this.whatsapp.listTemplates(wabaId)) {
      const def = wanted.get(`${remote.name}|${remote.language}`);
      if (!def) continue;
      await this.upsert(wabaId, def, {
        status: toTemplateStatus(remote.status),
        category: remote.category.toUpperCase(),
        metaTemplateId: remote.id,
        rejectedReason: remote.rejected_reason && remote.rejected_reason !== 'NONE' ? remote.rejected_reason : null,
      });
      updated++;
    }
    return updated;
  }

  /**
   * Applies a `message_template_status_update` webhook. Only updates rows we
   * created, so a webhook can never add templates to the table.
   */
  async applyStatusUpdate(wabaId: string, value: unknown): Promise<boolean> {
    const parsed = StatusUpdateSchema.safeParse(value);
    if (!parsed.success) return false;
    const update = parsed.data;
    const status = toTemplateStatus(update.event);
    const { count } = await this.prisma.messageTemplate.updateMany({
      where: { wabaId, name: update.message_template_name, language: update.message_template_language },
      data: {
        status,
        metaTemplateId: update.message_template_id,
        rejectedReason: status === 'REJECTED' && update.reason && update.reason !== 'NONE' ? update.reason : null,
      },
    });
    if (count > 0) {
      this.logger.info({ wabaId, template: update.message_template_name, status }, 'template status updated by Meta');
    }
    return count > 0;
  }

  private async upsert(
    wabaId: string,
    def: TemplateDefinition,
    state: { status: TemplateStatus; category: string; metaTemplateId: string; rejectedReason: string | null },
  ): Promise<void> {
    await this.prisma.messageTemplate.upsert({
      where: { wabaId_name_language: { wabaId, name: def.name, language: def.language } },
      create: { wabaId, name: def.name, language: def.language, requestedCategory: def.category, ...state },
      update: { requestedCategory: def.category, ...state },
    });
  }
}
