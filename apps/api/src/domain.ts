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

export const signSchema = z.object({
  expectedVersion: z.number().int().min(1)
}).strict();

export const addendumSchema = z.object({
  operationId: uuid,
  reason: z.string().trim().min(8).max(1000),
  content: z.string().trim().min(10).max(10000)
}).strict();

// --- MFA (TOTP) and SSO (OIDC) ---
export const totpCode = z.string().regex(/^\d{6}$/,'Código deve ter 6 dígitos');
const stepToken = z.string().min(20).max(4000);

export const mfaActivateSchema = z.object({ code: totpCode }).strict();
export const mfaVerifySchema = z.object({ mfaToken: stepToken, code: totpCode }).strict();
export const mfaRecoverySchema = z.object({ mfaToken: stepToken, recoveryCode: z.string().trim().min(8).max(40) }).strict();
export const mfaPasswordConfirmSchema = z.object({ password: z.string().min(1).max(256), code: totpCode }).strict();

const clinicalString = z.string().trim().max(5000);
export const aiSuggestionSchema = z.object({
  chief_complaint: clinicalString.nullable().optional(),
  hpi: clinicalString.nullable().optional(),
  review_of_systems:z.array(clinicalString).max(30).optional(),
  history:z.array(clinicalString).max(30).optional(),
  allergies:z.array(clinicalString).max(30).optional(),
  exam_findings:z.array(clinicalString).max(30),
  assessment:z.array(z.object({
    text:clinicalString,
    icd10:z.string().max(30).nullable().optional(),
    certainty:z.enum(['reported','suspected','confirmed'])
  }).strict()).max(30),
  medications_mentioned:z.array(z.object({
    name:z.string().trim().min(1).max(200),
    dose:z.string().max(120).nullable().optional(),
    route:z.string().max(120).nullable().optional(),
    frequency:z.string().max(120).nullable().optional(),
    context:z.enum(['reported','proposed'])
  }).strict()).max(50),
  plan_as_spoken:z.array(clinicalString).max(50),
  uncertainties:z.array(clinicalString).max(50),
  evidence_quotes:z.array(clinicalString).max(30).optional(),
  requires_physician_review:z.boolean().optional()
}).strict();
