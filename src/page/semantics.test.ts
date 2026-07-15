import { describe, expect, it } from 'vitest';
import type { FormPlan } from '../api/form-planner';
import type { PageProbeSnapshot } from './probe';
import {
  applyFormPlan,
  buildFormPlanningObservation,
  hasPlausibleCommentControls,
} from './semantics';
import type { PageAnalysis } from './types';

function snapshot(
  controls: PageProbeSnapshot['controlCandidates']
): PageProbeSnapshot {
  return {
    snapshotId: 'snapshot-1',
    url: 'https://blog.example/post',
    formCandidates: [],
    controlCandidates: controls,
  };
}

function control(
  overrides: Partial<PageProbeSnapshot['controlCandidates'][number]>
): PageProbeSnapshot['controlCandidates'][number] {
  return {
    candidateId: 'control-1',
    formId: null,
    tag: 'input',
    type: 'text',
    attributes: {},
    labels: [],
    nearbyText: [],
    ancestorTokens: [],
    requiredSignals: [],
    visible: true,
    enabled: true,
    hasValue: false,
    ...overrides,
  };
}

function analysis(): PageAnalysis {
  return {
    page: {
      url: 'https://blog.example/post',
      title: 'Kolagen',
      description: 'Article description',
      excerpt: 'Article excerpt',
      language: 'sr',
      hasWebsiteField: false,
    },
    form: {
      readiness: 'not_found',
      editorLabel: '',
      submitLabel: '',
      hasNameField: false,
      hasEmailField: false,
      hasWebsiteField: false,
      message: 'COMMENT_FORM_NOT_FOUND',
    },
  };
}

describe('comment form semantics', () => {
  it('recognizes a usable multiline editor and action control without relying on their language', () => {
    const page = snapshot([
      control({
        candidateId: 'comment',
        tag: 'textarea',
        type: 'textarea',
      }),
      control({
        candidateId: 'submit',
        tag: 'button',
        type: 'button',
        nearbyText: ['Potvrdi'],
      }),
    ]);

    expect(hasPlausibleCommentControls(page)).toBe(true);
  });

  it('allows an initially disabled action but still requires an enabled editor', () => {
    const disabledAction = control({
      candidateId: 'submit',
      tag: 'button',
      type: 'button',
      enabled: false,
    });
    const enabledEditor = control({
      candidateId: 'comment',
      tag: 'textarea',
      type: 'textarea',
    });
    const disabledEditor = { ...enabledEditor, enabled: false };

    expect(
      hasPlausibleCommentControls(snapshot([enabledEditor, disabledAction]))
    ).toBe(true);
    expect(
      hasPlausibleCommentControls(snapshot([disabledEditor, disabledAction]))
    ).toBe(false);
  });

  it('converts every observed form and control into bounded planning candidates', () => {
    const page = snapshot([
      control({
        candidateId: 'field-comment',
        formId: 'form-comment',
        tag: 'textarea',
        type: 'textarea',
        attributes: { id: 'comment', name: 'comment' },
        labels: ['Komentar *'],
        nearbyText: ['Ostavite komentar'],
        headings: ['Ostavite komentar'],
        requiredSignals: ['label-marker:*'],
      }),
      control({
        candidateId: 'button-confirm',
        formId: 'form-comment',
        tag: 'button',
        type: 'button',
        attributes: { class: 'comment-submit', type: 'button' },
        nearbyText: ['Potvrdi'],
      }),
    ]);
    page.formCandidates = [
      {
        formId: 'form-comment',
        tag: 'form',
        attributes: { id: 'comment-form', method: 'post' },
        headings: ['Ostavite komentar'],
        controlCandidateIds: ['field-comment', 'button-confirm'],
      },
    ];

    expect(
      buildFormPlanningObservation(page, {
        title: 'Kolagen',
        language: 'sr',
      })
    ).toEqual({
      schemaVersion: 1,
      snapshotId: 'snapshot-1',
      page: {
        url: 'https://blog.example/post',
        title: 'Kolagen',
        language: 'sr',
      },
      candidates: [
        {
          candidateId: 'form-comment',
          kind: 'form',
          attributes: { id: 'comment-form', method: 'post' },
          headings: ['Ostavite komentar'],
          visible: true,
          enabled: true,
        },
        {
          candidateId: 'field-comment',
          kind: 'field',
          formCandidateId: 'form-comment',
          controlType: 'textarea',
          attributes: { id: 'comment', name: 'comment' },
          labels: ['Komentar *'],
          nearbyText: ['Ostavite komentar'],
          headings: ['Ostavite komentar'],
          requiredSignals: ['label-marker:*'],
          visible: true,
          enabled: true,
        },
        {
          candidateId: 'button-confirm',
          kind: 'button',
          formCandidateId: 'form-comment',
          controlType: 'button',
          attributes: { class: 'comment-submit', type: 'button' },
          labels: [],
          nearbyText: ['Potvrdi'],
          requiredSignals: [],
          visible: true,
          enabled: true,
        },
      ],
    });
  });

  it('passes bounded ancestor context to the semantic planner', () => {
    const longAncestor = `div.${'v'.repeat(200)}`;
    const page = snapshot([
      control({
        candidateId: 'field-name',
        ancestorTokens: [
          longAncestor,
          'div.vName',
          'form.vCard',
          'section.comments',
          'main',
          'body',
          'html',
        ],
      }),
    ]);

    const observation = buildFormPlanningObservation(page, {
      title: 'Kolagen',
      language: 'sr',
    });

    expect(observation.candidates[0]?.ancestorTokens).toEqual([
      longAncestor.slice(0, 160),
      'div.vName',
      'form.vCard',
      'section.comments',
      'main',
      'body',
    ]);
  });

  it('applies a valid plan and combines DOM-required fields with model-required roles', () => {
    const page = snapshot([
      control({
        candidateId: 'field-comment',
        formId: 'form-comment',
        tag: 'textarea',
        type: 'textarea',
        labels: ['Komentar *'],
        requiredSignals: ['label-marker:*'],
      }),
      control({
        candidateId: 'field-name',
        formId: 'form-comment',
        attributes: { name: 'vName' },
        labels: ['Vaše ime *'],
        requiredSignals: ['ancestor-class:required'],
      }),
      control({
        candidateId: 'field-email',
        formId: 'form-comment',
        type: 'email',
        attributes: { name: 'email' },
      }),
      control({
        candidateId: 'field-website',
        formId: 'form-comment',
        type: 'url',
        attributes: { name: 'website' },
      }),
      control({
        candidateId: 'button-confirm',
        formId: 'form-comment',
        tag: 'button',
        type: 'button',
        nearbyText: ['Potvrdi'],
        enabled: false,
      }),
    ]);
    page.formCandidates = [
      {
        formId: 'form-comment',
        tag: 'form',
        attributes: { id: 'comment-form' },
        controlCandidateIds: page.controlCandidates.map(
          (candidate) => candidate.candidateId
        ),
      },
    ];
    const formPlan: FormPlan = {
      schemaVersion: 1,
      snapshotId: 'snapshot-1',
      decision: 'commentable',
      formCandidateId: 'form-comment',
      bindings: {
        comment: 'field-comment',
        name: 'field-name',
        email: 'field-email',
        website: 'field-website',
      },
      submitCandidateId: 'button-confirm',
      requiredRoles: ['email'],
      uncertainties: [],
    };
    const original = analysis();

    const planned = applyFormPlan(original, page, formPlan);

    expect(planned).not.toBe(original);
    expect(planned.form).toEqual({
      readiness: 'ready',
      editorLabel: 'Komentar *',
      submitLabel: 'Potvrdi',
      hasNameField: true,
      hasEmailField: true,
      hasWebsiteField: true,
      message: 'COMMENT_FORM_READY',
    });
    expect(planned.formPlan).toEqual({
      ...formPlan,
      requiredRoles: ['comment', 'name', 'email'],
    });
    expect(original.form.readiness).toBe('not_found');
  });

  it('accepts a coherent form-less contenteditable comment surface', () => {
    const page = snapshot([
      control({
        candidateId: 'field-comment',
        tag: 'div',
        type: 'contenteditable',
        labels: ['Write a reply'],
      }),
      control({
        candidateId: 'button-reply',
        tag: 'div',
        type: 'button',
        attributes: { role: 'button' },
        nearbyText: ['Reply'],
        enabled: false,
      }),
    ]);
    const formPlan: FormPlan = {
      schemaVersion: 1,
      snapshotId: 'snapshot-1',
      decision: 'commentable',
      formCandidateId: null,
      bindings: { comment: 'field-comment' },
      submitCandidateId: 'button-reply',
      requiredRoles: ['comment'],
      uncertainties: [],
    };

    expect(applyFormPlan(analysis(), page, formPlan)).toMatchObject({
      form: {
        readiness: 'ready',
        editorLabel: 'Write a reply',
        submitLabel: 'Reply',
      },
      formPlan,
    });
  });

  it('rejects an action-like element when the model binds it as the comment field', () => {
    const page = snapshot([
      control({
        candidateId: 'field-comment',
        tag: 'div',
        type: 'contenteditable',
        attributes: { role: 'button' },
      }),
      control({
        candidateId: 'button-reply',
        tag: 'button',
        type: 'button',
      }),
    ]);
    const formPlan: FormPlan = {
      schemaVersion: 1,
      snapshotId: 'snapshot-1',
      decision: 'commentable',
      formCandidateId: null,
      bindings: { comment: 'field-comment' },
      submitCandidateId: 'button-reply',
      requiredRoles: ['comment'],
      uncertainties: [],
    };

    expect(() => applyFormPlan(analysis(), page, formPlan)).toThrow(
      'FORM_PLAN_COMMENT_KIND_INVALID'
    );
  });

  it('rejects a multiline editor when the model binds it as an identity field', () => {
    const page = snapshot([
      control({
        candidateId: 'field-comment',
        tag: 'textarea',
        type: 'textarea',
      }),
      control({
        candidateId: 'field-name',
        tag: 'textarea',
        type: 'textarea',
      }),
      control({
        candidateId: 'button-submit',
        tag: 'button',
        type: 'button',
      }),
    ]);
    const formPlan: FormPlan = {
      schemaVersion: 1,
      snapshotId: 'snapshot-1',
      decision: 'commentable',
      formCandidateId: null,
      bindings: { comment: 'field-comment', name: 'field-name' },
      submitCandidateId: 'button-submit',
      requiredRoles: ['comment'],
      uncertainties: [],
    };

    expect(() => applyFormPlan(analysis(), page, formPlan)).toThrow(
      'FORM_PLAN_FIELD_KIND_INVALID'
    );
  });

  it.each([
    [
      'comment binding',
      { bindings: {}, submitCandidateId: 'button-submit' },
      'FORM_PLAN_COMMENT_REQUIRED',
    ],
    [
      'submit binding',
      { bindings: { comment: 'field-comment' }, submitCandidateId: null },
      'FORM_PLAN_SUBMIT_REQUIRED',
    ],
  ] as const)(
    'rejects a commentable plan without its %s',
    (_missing, incomplete, error) => {
      const formPlan: FormPlan = {
        schemaVersion: 1,
        snapshotId: 'snapshot-1',
        decision: 'commentable',
        formCandidateId: null,
        bindings: incomplete.bindings,
        submitCandidateId: incomplete.submitCandidateId,
        requiredRoles: [],
        uncertainties: [],
      };

      expect(() => applyFormPlan(analysis(), snapshot([]), formPlan)).toThrow(
        error
      );
    }
  );

  it('rejects selected controls that do not belong to the planned form', () => {
    const page = snapshot([
      control({
        candidateId: 'field-comment',
        formId: 'form-comment',
        tag: 'textarea',
        type: 'textarea',
      }),
      control({
        candidateId: 'button-submit',
        formId: 'form-search',
        tag: 'button',
        type: 'button',
      }),
    ]);
    page.formCandidates = [
      {
        formId: 'form-comment',
        tag: 'form',
        attributes: {},
        controlCandidateIds: ['field-comment'],
      },
      {
        formId: 'form-search',
        tag: 'form',
        attributes: {},
        controlCandidateIds: ['button-submit'],
      },
    ];
    const formPlan: FormPlan = {
      schemaVersion: 1,
      snapshotId: 'snapshot-1',
      decision: 'commentable',
      formCandidateId: 'form-comment',
      bindings: { comment: 'field-comment' },
      submitCandidateId: 'button-submit',
      requiredRoles: ['comment'],
      uncertainties: [],
    };

    expect(() => applyFormPlan(analysis(), page, formPlan)).toThrow(
      'FORM_PLAN_FORM_MISMATCH'
    );
  });

  it.each([
    ['hidden comment', { commentVisible: false, nameEnabled: true }],
    ['disabled identity field', { commentVisible: true, nameEnabled: false }],
  ] as const)('rejects an unavailable %s', (_case, availability) => {
    const page = snapshot([
      control({
        candidateId: 'field-comment',
        tag: 'textarea',
        type: 'textarea',
        visible: availability.commentVisible,
      }),
      control({
        candidateId: 'field-name',
        enabled: availability.nameEnabled,
      }),
      control({
        candidateId: 'button-submit',
        tag: 'button',
        type: 'button',
      }),
    ]);
    const formPlan: FormPlan = {
      schemaVersion: 1,
      snapshotId: 'snapshot-1',
      decision: 'commentable',
      formCandidateId: null,
      bindings: { comment: 'field-comment', name: 'field-name' },
      submitCandidateId: 'button-submit',
      requiredRoles: ['comment'],
      uncertainties: [],
    };

    expect(() => applyFormPlan(analysis(), page, formPlan)).toThrow(
      'FORM_PLAN_CANDIDATE_UNAVAILABLE'
    );
  });

  it('rejects a model-required role that has no bound field', () => {
    const page = snapshot([
      control({
        candidateId: 'field-comment',
        tag: 'textarea',
        type: 'textarea',
      }),
      control({
        candidateId: 'button-submit',
        tag: 'button',
        type: 'button',
      }),
    ]);
    const formPlan: FormPlan = {
      schemaVersion: 1,
      snapshotId: 'snapshot-1',
      decision: 'commentable',
      formCandidateId: null,
      bindings: { comment: 'field-comment' },
      submitCandidateId: 'button-submit',
      requiredRoles: ['comment', 'email'],
      uncertainties: [],
    };

    expect(() => applyFormPlan(analysis(), page, formPlan)).toThrow(
      'FORM_PLAN_REQUIRED_ROLE_UNBOUND'
    );
  });

  it('does not execute a commentable plan that still reports uncertainty', () => {
    const formPlan: FormPlan = {
      schemaVersion: 1,
      snapshotId: 'snapshot-1',
      decision: 'commentable',
      formCandidateId: null,
      bindings: { comment: 'field-comment' },
      submitCandidateId: 'button-submit',
      requiredRoles: ['comment'],
      uncertainties: ['The action may be a preview control'],
    };

    expect(applyFormPlan(analysis(), snapshot([]), formPlan)).toMatchObject({
      form: {
        readiness: 'not_found',
        message: 'FORM_PLAN_NEEDS_REVIEW',
      },
      formPlan,
    });
  });

  it('does not execute when an observed required control in the form is unbound', () => {
    const page = snapshot([
      control({
        candidateId: 'field-comment',
        formId: 'form-comment',
        tag: 'textarea',
        type: 'textarea',
      }),
      control({
        candidateId: 'field-phone',
        formId: 'form-comment',
        attributes: { name: 'phone' },
        requiredSignals: ['nearby-marker:*'],
      }),
      control({
        candidateId: 'button-submit',
        formId: 'form-comment',
        tag: 'button',
        type: 'button',
      }),
    ]);
    page.formCandidates = [
      {
        formId: 'form-comment',
        tag: 'form',
        attributes: {},
        controlCandidateIds: ['field-comment', 'field-phone', 'button-submit'],
      },
    ];
    const formPlan: FormPlan = {
      schemaVersion: 1,
      snapshotId: 'snapshot-1',
      decision: 'commentable',
      formCandidateId: 'form-comment',
      bindings: { comment: 'field-comment' },
      submitCandidateId: 'button-submit',
      requiredRoles: ['comment'],
      uncertainties: [],
    };

    expect(applyFormPlan(analysis(), page, formPlan)).toMatchObject({
      form: {
        readiness: 'not_found',
        message: 'FORM_PLAN_NEEDS_REVIEW',
      },
      formPlan,
    });
  });

  it.each([
    ['not_commentable', 'FORM_PLAN_NOT_COMMENTABLE'],
    ['needs_review', 'FORM_PLAN_NEEDS_REVIEW'],
  ] as const)(
    'maps a %s decision to an explicit non-ready result',
    (decision, message) => {
      const original = analysis();
      original.page.hasWebsiteField = true;
      original.form = {
        readiness: 'ready',
        editorLabel: 'Old editor',
        submitLabel: 'Old submit',
        hasNameField: true,
        hasEmailField: true,
        hasWebsiteField: true,
        message: 'COMMENT_FORM_READY',
      };
      const formPlan: FormPlan = {
        schemaVersion: 1,
        snapshotId: 'snapshot-1',
        decision,
        formCandidateId: null,
        bindings: {},
        submitCandidateId: null,
        requiredRoles: [],
        uncertainties: ['No reliable comment action'],
      };

      expect(applyFormPlan(original, snapshot([]), formPlan)).toMatchObject({
        page: { hasWebsiteField: false },
        form: {
          readiness: 'not_found',
          editorLabel: '',
          submitLabel: '',
          hasNameField: false,
          hasEmailField: false,
          hasWebsiteField: false,
          message,
        },
        formPlan,
      });
    }
  );
});
