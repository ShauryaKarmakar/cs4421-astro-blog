import { getCollection } from 'astro:content';
import rss from '@astrojs/rss';
import { SITE_DESCRIPTION, SITE_TITLE } from '../consts';

interface FeedContext {
	site: URL | undefined;
}

/**
 * Build the blog feed from the content collection.
 *
 * Both the SSR endpoint and the static endpoint call this, so the feed can
 * never describe a different set of articles than the deployed site. The item
 * links are directory-format routes, matching the generated `index.html` files.
 */
export async function GET({ site }: FeedContext) {
	if (!site) {
		throw new Error('The RSS feed requires `site` to be configured in the Astro config.');
	}

	const posts = (await getCollection('blog')).sort(
		(a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf(),
	);

	return rss({
		title: `${SITE_TITLE} writing`,
		description: SITE_DESCRIPTION,
		site,
		items: posts.map((post) => ({
			title: post.data.title,
			description: post.data.description,
			pubDate: post.data.pubDate,
			link: `/blog/${post.id}/`,
		})),
	});
}
