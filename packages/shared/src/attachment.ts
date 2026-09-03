import { z } from 'zod';
import { idSchema, nullableTimestampSchema, timestampsSchema } from './common.js';

export const attachmentSchema = z
  .object({
    id: idSchema,
    messageId: idSchema,
    filename: z.string().nullable(),
    contentType: z.string().nullable(),
    size: z.number().int().min(0).nullable(),
    /** null 表示正文还没落盘，可凭 partId 按需拉取。 */
    sha256: z.string().nullable(),
    partId: z.string().nullable(),
    contentId: z.string().nullable(),
    isInline: z.boolean(),
    downloadedAt: nullableTimestampSchema,
  })
  .merge(timestampsSchema);
export type Attachment = z.infer<typeof attachmentSchema>;
