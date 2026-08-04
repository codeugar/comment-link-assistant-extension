import type { SiteProfile } from '@/types';
import { describe, expect, it } from 'vitest';
import {
  type PromotingSiteFormValues,
  validatePromotingSiteInput,
} from './promoting-site';

const values: PromotingSiteFormValues = {
  label: '  My Site  ',
  websiteUrl: 'www.example.com/',
  displayName: 'Author',
  email: 'owner@example.com',
  linkMode: 'a-tag-newline',
};

describe('promoting site creation rules', () => {
  it('requires a name and URL and normalizes accepted URL forms to HTTPS', () => {
    expect(
      validatePromotingSiteInput({ ...values, label: '', websiteUrl: '' }, [])
        .fieldErrors
    ).toEqual({
      label: 'SITE_NAME_REQUIRED',
      websiteUrl: 'SITE_URL_REQUIRED',
    });
    for (const websiteUrl of [
      'www.example.com/',
      'http://www.example.com/',
      'https://www.example.com/',
    ]) {
      expect(
        validatePromotingSiteInput(
          { ...values, websiteUrl },
          [],
          `site-${websiteUrl.startsWith('http') ? 'protocol' : 'bare'}`
        ).site?.websiteUrl
      ).toBe('https://www.example.com');
    }
  });

  it('rejects invalid email, duplicate URLs, and the twenty-first site', () => {
    expect(
      validatePromotingSiteInput({ ...values, email: 'not-an-email' }, [])
        .fieldErrors.email
    ).toBe('SITE_EMAIL_INVALID');
    expect(
      validatePromotingSiteInput(values, [
        { ...values, id: 'existing', websiteUrl: 'https://www.example.com' },
      ]).formError
    ).toBe('SITE_DUPLICATE');
    expect(
      validatePromotingSiteInput(
        { ...values, websiteUrl: 'http://www.example.com/' },
        [
          {
            ...values,
            id: 'existing-http',
            websiteUrl: 'http://www.example.com',
          },
        ]
      ).formError
    ).toBe('SITE_DUPLICATE');
    const sites = Array.from(
      { length: 20 },
      (_, index) =>
        ({
          ...values,
          id: `site-${index}`,
          websiteUrl: `https://site-${index}.example`,
        }) as SiteProfile
    );
    expect(validatePromotingSiteInput(values, sites).formError).toBe(
      'SITE_LIMIT'
    );
  });
});
