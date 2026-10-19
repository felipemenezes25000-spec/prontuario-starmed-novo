import { z } from 'zod';
import { BadRequestException } from '@nestjs/common';

export const uuid = z.string().uuid();
export const role = z.enum(['admin','doctor','nurse','reception']);
export const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(256)
}).strict();

export const userSchema = z.object({
  email: z.string().email().max(254),
  displayName: z.string().min(2).max(160),
  role,
  password: z.string().min(12).max(256)
}).strict();

export const patientSchema = z.object({
  fullName: z.string().trim().min(2).max(255),
  birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  administrativeGender: z.enum(['male','female','other','unknown']).optional(),
  externalId: z.string().max(70).optional(),
  phone: z.string().max(35).optional(),
  socialDeterminants: z.record(z.unknown()).optional()
}).strict();

export const encounterSchema = z.object({
  patientId: uuid,
  specialty: z.enum(['general','cardiology','orthopedics','pediatrics','neurology','psychiatry']),
  type: z.enum(['consultation','follow_up','emergency','teleconsultation']),
  reasonForVisit: z.string().max(4000)
}).strict();

export const appointmentSchema = z.object({
  patientId: uuid,
  practitionerId: uuid,
  scheduledAt: z.string().datetime({offset:true}),
  durationMinutes: z.number().int().min(5).max(720),
  kind: z.enum(['consultation','follow_up','teleconsultation'])
}).strict();

export const draftSchema = z.object({
  expectedVersion: z.number().int().min(0),
  operationId: uuid,
  templateId: z.string().min(1).max(90),
  sections: z.record(z.string().max(20000))
}).strict();

export const aiSchema = z.object({transcript:z.string().min(10).max(20000)}).strict();

export function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException({
    message:'Invalid request data',
    issues: parsed.error.issues.map(x=>({path:x.path.join('.'),message:x.message}))
  });
  return parsed.data;
}
export function validateNoteForSignature(content: unknown): boolean {
  const note = z.object({sections:z.record(z.string())}).safeParse(content);
  if (!note.success) return false;
  const s = note.data.sections;
  return Boolean(s.assessment?.trim() && s.plan?.trim());
}
