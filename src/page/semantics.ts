import type { FormPlan, FormPlanningObservation } from '../api/form-planner';
import type { PageControlCandidate, PageProbeSnapshot } from './probe';
import type { PageAnalysis, TargetPageContext } from './types';

type FormRole = FormPlan['requiredRoles'][number];

export type PlannedPageAnalysis = PageAnalysis & {
  formPlan: FormPlan;
};

function nonReadyPlan(
  analysis: PageAnalysis,
  plan: FormPlan,
  message: 'FORM_PLAN_NOT_COMMENTABLE' | 'FORM_PLAN_NEEDS_REVIEW'
): PlannedPageAnalysis {
  return {
    ...analysis,
    page: {
      ...analysis.page,
      hasWebsiteField: false,
    },
    form: {
      readiness: 'not_found',
      editorLabel: '',
      submitLabel: '',
      hasNameField: false,
      hasEmailField: false,
      hasWebsiteField: false,
      message,
    },
    formPlan: plan,
  };
}

function isUsable(candidate: PageControlCandidate): boolean {
  return candidate.visible && candidate.enabled;
}

function isMultilineEditor(candidate: PageControlCandidate): boolean {
  return candidate.tag === 'textarea' || candidate.type === 'contenteditable';
}

function isActionControl(candidate: PageControlCandidate): boolean {
  return (
    candidate.type === 'button' ||
    (candidate.tag === 'input' &&
      (candidate.type === 'submit' || candidate.type === 'button')) ||
    candidate.attributes.role === 'button'
  );
}

function isRevealControl(candidate: PageControlCandidate): boolean {
  return isActionControl(candidate) || candidate.tag === 'a';
}

function isIdentityField(
  candidate: PageControlCandidate,
  role: Exclude<FormRole, 'comment'>
): boolean {
  if (candidate.tag !== 'input') return false;
  if (role === 'name') return candidate.type === 'text';
  if (role === 'email') {
    return candidate.type === 'text' || candidate.type === 'email';
  }
  return candidate.type === 'text' || candidate.type === 'url';
}

export function hasPlausibleCommentControls(
  snapshot: PageProbeSnapshot
): boolean {
  return (
    snapshot.controlCandidates.some(
      (candidate) => isUsable(candidate) && isMultilineEditor(candidate)
    ) &&
    snapshot.controlCandidates.some(
      (candidate) => candidate.visible && isActionControl(candidate)
    )
  );
}

export function buildFormPlanningObservation(
  snapshot: PageProbeSnapshot,
  pageContext: Pick<TargetPageContext, 'title' | 'language'>
): FormPlanningObservation {
  return {
    schemaVersion: 1,
    snapshotId: snapshot.snapshotId,
    page: {
      url: snapshot.url,
      title: pageContext.title,
      language: pageContext.language,
    },
    candidates: [
      ...snapshot.formCandidates.map((form) => ({
        candidateId: form.formId,
        kind: 'form' as const,
        attributes: { ...form.attributes },
        ...((form.headings?.length ?? 0) > 0
          ? { headings: [...(form.headings ?? [])] }
          : {}),
        visible: true,
        enabled: true,
      })),
      ...snapshot.controlCandidates.map((candidate) => ({
        candidateId: candidate.candidateId,
        kind: isRevealControl(candidate)
          ? ('button' as const)
          : ('field' as const),
        ...(candidate.formId ? { formCandidateId: candidate.formId } : {}),
        controlType: candidate.type,
        attributes: { ...candidate.attributes },
        labels: [...candidate.labels],
        nearbyText: [...candidate.nearbyText],
        ...((candidate.headings?.length ?? 0) > 0
          ? { headings: [...(candidate.headings ?? [])] }
          : {}),
        ...(candidate.ancestorTokens.length > 0
          ? {
              ancestorTokens: candidate.ancestorTokens
                .slice(0, 6)
                .map((token) => token.slice(0, 160)),
            }
          : {}),
        requiredSignals: [...candidate.requiredSignals],
        visible: candidate.visible,
        enabled: candidate.enabled,
      })),
    ],
  };
}

function candidateLabel(candidate: PageControlCandidate): string {
  return (
    candidate.labels[0] ??
    candidate.nearbyText[0] ??
    candidate.attributes['aria-label'] ??
    candidate.attributes.name ??
    candidate.attributes.id ??
    candidate.candidateId
  );
}

export function applyFormPlan(
  analysis: PageAnalysis,
  snapshot: PageProbeSnapshot,
  plan: FormPlan
): PlannedPageAnalysis {
  if (plan.snapshotId !== snapshot.snapshotId) {
    throw new Error('FORM_PLAN_SNAPSHOT_MISMATCH');
  }
  if (plan.decision !== 'commentable' || plan.uncertainties.length > 0) {
    return nonReadyPlan(
      analysis,
      plan,
      plan.decision === 'not_commentable'
        ? 'FORM_PLAN_NOT_COMMENTABLE'
        : 'FORM_PLAN_NEEDS_REVIEW'
    );
  }
  const form = plan.formCandidateId
    ? snapshot.formCandidates.find(
        (candidate) => candidate.formId === plan.formCandidateId
      )
    : null;
  if (plan.formCandidateId && !form) {
    throw new Error('FORM_PLAN_FORM_NOT_FOUND');
  }
  if (!plan.bindings.comment) throw new Error('FORM_PLAN_COMMENT_REQUIRED');
  if (!plan.submitCandidateId) throw new Error('FORM_PLAN_SUBMIT_REQUIRED');

  const selectedCandidate = (candidateId: string): PageControlCandidate => {
    const candidate = snapshot.controlCandidates.find(
      (controlCandidate) => controlCandidate.candidateId === candidateId
    );
    if (!candidate) throw new Error('FORM_PLAN_CANDIDATE_NOT_FOUND');
    if (
      candidate.formId !== plan.formCandidateId ||
      (form && !form.controlCandidateIds.includes(candidate.candidateId))
    ) {
      throw new Error('FORM_PLAN_FORM_MISMATCH');
    }
    return candidate;
  };

  const comment = selectedCandidate(plan.bindings.comment);
  if (!isMultilineEditor(comment) || isActionControl(comment)) {
    throw new Error('FORM_PLAN_COMMENT_KIND_INVALID');
  }
  if (!isUsable(comment)) throw new Error('FORM_PLAN_CANDIDATE_UNAVAILABLE');

  const submit = selectedCandidate(plan.submitCandidateId);
  if (!isActionControl(submit)) {
    throw new Error('FORM_PLAN_SUBMIT_KIND_INVALID');
  }
  if (!submit.visible) throw new Error('FORM_PLAN_CANDIDATE_UNAVAILABLE');

  const bindingRoles: FormRole[] = ['comment', 'name', 'email', 'website'];
  const boundCandidates = new Map<FormRole, PageControlCandidate>([
    ['comment', comment],
  ]);
  for (const role of bindingRoles.slice(1)) {
    const candidateId = plan.bindings[role];
    if (!candidateId) continue;
    const candidate = selectedCandidate(candidateId);
    if (
      !isIdentityField(candidate, role as Exclude<FormRole, 'comment'>) ||
      !isUsable(candidate)
    ) {
      throw new Error(
        !isIdentityField(candidate, role as Exclude<FormRole, 'comment'>)
          ? 'FORM_PLAN_FIELD_KIND_INVALID'
          : 'FORM_PLAN_CANDIDATE_UNAVAILABLE'
      );
    }
    boundCandidates.set(role, candidate);
  }

  const boundCandidateIds = new Set(
    Array.from(boundCandidates.values(), (candidate) => candidate.candidateId)
  );
  boundCandidateIds.add(submit.candidateId);
  if (
    form &&
    snapshot.controlCandidates.some(
      (candidate) =>
        candidate.formId === form.formId &&
        candidate.visible &&
        candidate.requiredSignals.length > 0 &&
        !boundCandidateIds.has(candidate.candidateId)
    )
  ) {
    return nonReadyPlan(analysis, plan, 'FORM_PLAN_NEEDS_REVIEW');
  }

  const requiredRoleSet = new Set<FormRole>(plan.requiredRoles);
  for (const [role, candidate] of boundCandidates) {
    if (candidate.requiredSignals.length > 0) requiredRoleSet.add(role);
  }
  const requiredRoles = bindingRoles.filter((role) =>
    requiredRoleSet.has(role)
  );
  for (const role of requiredRoles) {
    if (!boundCandidates.has(role)) {
      throw new Error('FORM_PLAN_REQUIRED_ROLE_UNBOUND');
    }
  }

  const hasNameField = boundCandidates.has('name');
  const hasEmailField = boundCandidates.has('email');
  const hasWebsiteField = boundCandidates.has('website');

  return {
    ...analysis,
    page: {
      ...analysis.page,
      hasWebsiteField,
    },
    form: {
      readiness: 'ready',
      editorLabel: candidateLabel(comment),
      submitLabel: candidateLabel(submit),
      hasNameField,
      hasEmailField,
      hasWebsiteField,
      message: 'COMMENT_FORM_READY',
    },
    formPlan: {
      ...plan,
      requiredRoles,
    },
  };
}
