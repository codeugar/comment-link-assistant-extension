import { describe, expect, it } from 'vitest';
import { TargetUrlError, parseTargetUrls } from './urls';

describe('parseTargetUrls', () => {
  it('normalizes, removes fragments, ignores blank lines, and deduplicates', () => {
    expect(
      parseTargetUrls(`
        HTTPS://Blog.Example:443/post#comments

        https://blog.example/post
        http://forum.example:80/thread?sort=new#reply
      `)
    ).toEqual([
      'https://blog.example/post',
      'http://forum.example/thread?sort=new',
    ]);
  });

  it('reports the original line number when any non-http URL is invalid', () => {
    try {
      parseTargetUrls('https://valid.example/post\n\nfile:///tmp/post.html');
      expect.fail('Expected parseTargetUrls to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(TargetUrlError);
      expect(error).toMatchObject({
        code: 'TARGET_URL_INVALID',
        lineNumber: 3,
        value: 'file:///tmp/post.html',
      });
      expect((error as Error).message).toContain('3');
    }
  });

  it('rejects malformed and protocol-relative input instead of guessing', () => {
    expect(() => parseTargetUrls('//blog.example/post')).toThrowError(
      TargetUrlError
    );
    expect(() => parseTargetUrls('blog.example/post')).toThrowError(
      TargetUrlError
    );
    expect(() =>
      parseTargetUrls('https://user:password@blog.example/post')
    ).toThrowError(TargetUrlError);
  });

  it('rejects an empty target list with line zero', () => {
    expect(() => parseTargetUrls('\n   \n')).toThrowError(
      expect.objectContaining({
        code: 'TARGET_URL_INVALID',
        lineNumber: 0,
        value: '',
      })
    );
  });

  it('rejects a batch larger than the storage-safe target limit', () => {
    const targets = Array.from(
      { length: 201 },
      (_, index) => `https://blog${index}.example/post`
    ).join('\n');

    expect(() => parseTargetUrls(targets)).toThrowError(
      'TARGET_URL_LIMIT_EXCEEDED'
    );
  });
});
