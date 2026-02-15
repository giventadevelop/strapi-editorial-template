# Article Description: Rich Text (Blocks) — Editor & Frontend Guide

The **Editorial – Article** `description` field is a **Rich Text (Blocks)** field. Content is stored as structured blocks (paragraphs, headings, images, lists, etc.), not as plain text or Markdown.

---

## For Editors: Getting Images and Formatting to Display Correctly

### Why Markdown image syntax shows as a link

If you paste **Markdown** like `![alt text](http://localhost:1337/uploads/...)` into the description field, Strapi stores it as **plain text** inside a paragraph block. The editor and the frontend will show that text literally — they do **not** parse Markdown into clickable or embedded images.

- **In the admin:** You see the raw `![...](url)` because it’s just text.
- **On the frontend:** Same — it appears as a string, and everything can look like one paragraph if the frontend doesn’t render blocks.

### Strapi 5 limitation: "Insert image" inserts a link, not an embedded image

In **Strapi 5**, when you click **Insert image**, open the **Add new asset** dialog, select an image, and click **Finish**, Strapi inserts a **link** to the image URL (stored and shown as `![filename](http://localhost:1337/uploads/...)`), **not** an image block. So in the admin you always see the raw link text; on the frontend it renders as a link unless you use the workaround below. This is a [known Strapi 5 limitation](https://feedback.strapi.io/feature-requests/p/live-rendering-previews-of-image-on-rich-text-blocks-editor).

**Recommended workaround — use the article blocks for images:** Do **not** rely on the description field for inline images. Scroll to **"+ Add a component to blocks"** below the description. Add a **Media** component when you want an image (it shows the image in the admin and the frontend can render it as `<img>`). Add **Rich text** components for paragraphs. You can mix **Rich text** and **Media** blocks in any order (e.g. paragraph → image → paragraph).

**Optional frontend workaround:** If you already have description content where "Insert image" was used, the API returns **link** blocks pointing to image URLs. The frontend can treat those as images (see Frontend section below for a custom renderer example).

### How to get paragraphs and line breaks on the frontend

- Use **Enter** to create new paragraphs. Each paragraph is stored as a separate **paragraph block**.
- Use the **Headings** dropdown for headings (stored as heading blocks).
- Use **Bold**, **Italic**, **Lists**, **Alignment**, etc. — they are stored as part of the blocks.

The frontend must render these **blocks** (see below). If it only shows `article.description` as one string, you will see a single block of text. Once the frontend uses the block renderer, paragraphs and formatting will appear correctly.

---

## For Frontend Developers: Rendering the Description

### API response shape

`article.description` from the Strapi API is **not** a string. It is an array of **blocks** (Strapi 5 Blocks format), for example:

```json
[
  { "type": "paragraph", "children": [{ "type": "text", "text": "First paragraph." }] },
  { "type": "paragraph", "children": [{ "type": "text", "text": "Second paragraph." }] },
  { "type": "image", "image": { "url": "/uploads/...", "alternativeText": "..." } }
]
```

If you render this as a single string (e.g. `{article.description}`), you will get broken output and no paragraphs/images.

### Recommended: Use the official block renderer (React)

Install and use **@strapi/blocks-react-renderer** so paragraphs, headings, lists, and **images** render correctly:

```bash
npm install @strapi/blocks-react-renderer react react-dom
```

Example (Next.js or any React app):

```jsx
import { BlocksRenderer, type BlocksContent } from '@strapi/blocks-react-renderer';

// After fetching article (with description populated)
const article = await fetchArticle(documentId); // your API call

// description can be null for old entries
const content: BlocksContent = article.description ?? [];

return (
  <div className="article-description">
    <BlocksRenderer content={content} />
  </div>
);
```

**Image URLs:** The renderer outputs `<img src="...">`. Strapi often returns **relative** URLs (e.g. `/uploads/...`). Build the full URL if needed:

```javascript
const STRAPI_URL = process.env.NEXT_PUBLIC_STRAPI_URL || 'http://localhost:1337';

// Optional: pass a custom blocks config to prepend base URL to image src
// Or ensure your Strapi upload provider uses absolute URLs in the API response.
```

If your API returns relative image URLs, you can wrap the renderer or use a custom `blocks` prop to prepend `STRAPI_URL` to image `src` values.

### Rendering "Insert image" links as actual images (custom block)

Because Strapi 5 inserts **link** blocks when you use "Insert image" from the asset dialog, the default renderer shows them as `<a href="...">...</a>`. To show them as images instead, pass a custom `blocks` (or equivalent) that detects link blocks whose `url` is an image and renders `<img>`:

```jsx
import { BlocksRenderer, type BlocksContent } from '@strapi/blocks-react-renderer';

const STRAPI_URL = process.env.NEXT_PUBLIC_STRAPI_URL || '';

function isImageUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const u = url.toLowerCase();
  return /\.(jpe?g|png|gif|webp|svg)(\?|$)/i.test(u) || u.includes('/uploads/');
}

// Custom blocks: render link blocks with image URLs as <img>
const blocks = {
  link: ({ children, url }) => {
    const fullUrl = url?.startsWith('http') ? url : `${STRAPI_URL}${url?.startsWith('/') ? '' : '/'}${url || ''}`;
    if (isImageUrl(fullUrl)) {
      return <img src={fullUrl} alt={typeof children === 'string' ? children : 'Image'} className="rich-text-inline-image" />;
    }
    return <a href={fullUrl}>{children}</a>;
  },
};

<BlocksRenderer content={content} blocks={blocks} />
```

Adjust the `link` block signature to match what `@strapi/blocks-react-renderer` passes (e.g. it might pass a different prop name for the URL). Check the library docs for the exact API.

### Non-React frontends

- Use a **blocks-to-HTML** converter that understands Strapi’s block types (paragraph, heading, list, image, link, etc.), or
- Call a small Node/API service that uses the same block structure and returns HTML.

Strapi’s block format is documented; the structure is an array of objects with `type` and type-specific fields (`children`, `image`, etc.).

---

## Summary

| Goal | What to do |
|------|------------|
| **Images show in admin and on site** | Use the article **blocks** (Add component → **Media**) for images. The description field’s "Insert image" only inserts a link (Strapi 5 limitation). |
| **Paragraphs and line breaks on frontend** | Use Enter and headings in the editor; ensure the **frontend** renders `description` with a **block renderer** (e.g. `BlocksRenderer`), not as a plain string. |
| **Frontend shows one line / one paragraph** | Switch from rendering `article.description` as text to rendering it as blocks (e.g. `<BlocksRenderer content={article.description} />`). |
| **Existing "Insert image" links in description** | On the frontend, use a custom block renderer that renders **link** blocks with image URLs as `<img>` (see above). |
