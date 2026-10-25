// src/lib/blogPost.ts
import type { CollectionEntry, RenderResult } from 'astro:content';

export type BlogEntry = CollectionEntry<'blog'>;
export type AuthorEntry = CollectionEntry<'authors'>;
export type AuthorReference = BlogEntry['data']['author'];

/**
 * The content lookups are injected so this module stays free of the
 * `astro:content` runtime and can be unit tested with plain fakes.
 */
export interface BlogLookup {
  getBlogEntry(id: string): Promise<BlogEntry | undefined>;
  getAuthorEntry(reference: AuthorReference): Promise<AuthorEntry | undefined>;
  render(post: BlogEntry): Promise<RenderResult>;
}

export interface LoadedBlogPost {
  post: BlogEntry;
  author: AuthorEntry | undefined;
  Content: RenderResult['Content'];
}

const maximumSlugLength = 128;
// A glob-loader id is the entry path without its extension, so a post inside a
// subdirectory keeps the directory as a path segment (`guides/first-post`).
// Each segment must look like a slug; rejecting empty segments and `..` stops
// a parameter from addressing another collection or escaping the blog
// directory before it reaches the content layer.
const slugSegmentPattern = /^[a-z0-9][a-z0-9._-]*$/i;

function isBlogSlug(candidate: string): boolean {
  return candidate
    .split('/')
    .every((segment) => slugSegmentPattern.test(segment));
}

/**
 * Normalize a catch-all route parameter into a content entry id.
 *
 * `Astro.params.slug` is undefined when the route is requested without a
 * segment, which is never a valid id. Nested paths keep their directory
 * segments, matching the ids the glob loader generates.
 */
export function normalizeBlogSlug(slug: string | undefined): string | null {
  if (typeof slug !== 'string') {
    return null;
  }

  const candidate = slug.trim();
  if (candidate.length === 0 || candidate.length > maximumSlugLength) {
    return null;
  }
  if (candidate.includes('..')) {
    return null;
  }
  if (!isBlogSlug(candidate)) {
    return null;
  }

  return candidate;
}

/**
 * Resolve the blog entry named by the URL and render its Markdown/MDX body.
 *
 * Returns null when the slug is missing, malformed, or does not name an
 * entry, so the page can answer 404 instead of starting a render with an
 * undefined entry. A missing author reference does not hide the post: the
 * layout treats the author as optional.
 */
export async function loadBlogPost(
  slug: string | undefined,
  lookup: BlogLookup,
): Promise<LoadedBlogPost | null> {
  const id = normalizeBlogSlug(slug);
  if (!id) {
    return null;
  }

  const post = await lookup.getBlogEntry(id);
  if (!post) {
    return null;
  }

  const [author, rendered] = await Promise.all([
    lookup.getAuthorEntry(post.data.author),
    lookup.render(post),
  ]);

  return { post, author, Content: rendered.Content };
}
