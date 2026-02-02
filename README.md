# 📰 Strapi News Editorial Template

A modern, headless CMS template for news and editorial content, built with [Strapi](https://strapi.io). This template is forked from the official Strapi Cloud editorial template and optimized for news organizations, online publications, and content-driven websites.

## ✨ Features

- **Article Management**: Create and manage news articles with rich content
- **Author Profiles**: Maintain detailed author information and bylines
- **Category Organization**: Organize content with flexible categorization
- **Media Library**: Store and manage images and media assets
- **SEO Optimized**: Built-in SEO components for better search visibility
- **Draft & Publish**: Editorial workflow with draft and publish capabilities
- **RESTful & GraphQL APIs**: Access your content via REST or GraphQL

## 🚀 Getting Started

### Prerequisites

- Node.js (v18.x or v20.x or v22.x)
- npm (v6.x or higher)

### Installation

1. Clone this repository:
```bash
git clone https://github.com/giventadevelop/strapi-editorial-template.git
cd strapi-editorial-template
```

2. Install dependencies:
```bash
npm install
```

3. Seed example data (optional):
```bash
npm run seed:example
```

4. Start the development server:
```bash
npm run develop
```

Your Strapi admin panel will be available at `http://localhost:1337/admin`

### Create your first administrator

When you start Strapi for the first time, you'll need to create an administrator account.

## 📖 Available Scripts

### `develop`

Start your Strapi application with autoReload enabled. [Learn more](https://docs.strapi.io/dev-docs/cli#strapi-develop)

```bash
npm run develop
```

### `start`

Start your Strapi application with autoReload disabled. [Learn more](https://docs.strapi.io/dev-docs/cli#strapi-start)

```bash
npm run start
```

### `build`

Build your admin panel. [Learn more](https://docs.strapi.io/dev-docs/cli#strapi-build)

```bash
npm run build
```

### `seed:example`

Seed the database with example news articles, authors, and categories.

```bash
npm run seed:example
```

## 📁 Content Types

This template includes the following content types:

### Collection Types

- **Article**: News articles with title, content, cover image, author, and category
- **Author**: Author profiles with name, avatar, email, and bio
- **Category**: Content categories for organizing articles

### Single Types

- **Global**: Site-wide settings (site name, favicon, default SEO)
- **About**: About page content

## 🎨 Components

Reusable components included:

- **Media**: Image and media component
- **Rich Text**: Rich text editor content
- **Quote**: Blockquote component
- **Slider**: Image slider/carousel
- **SEO**: SEO meta information

## ⚙️ Deployment

Strapi gives you many possible deployment options for your project including [Strapi Cloud](https://cloud.strapi.io).

Browse the [deployment section of the documentation](https://docs.strapi.io/dev-docs/deployment) to find the best solution for your use case.

### Deploy to Strapi Cloud

```bash
npm run deploy
```

## 📚 Learn more

- [Resource center](https://strapi.io/resource-center) - Strapi resource center
- [Strapi documentation](https://docs.strapi.io) - Official Strapi documentation
- [Strapi tutorials](https://strapi.io/tutorials) - List of tutorials made by the core team and the community
- [Strapi blog](https://strapi.io/blog) - Official Strapi blog containing articles made by the Strapi team and the community
- [Changelog](https://strapi.io/changelog) - Find out about the Strapi product updates, new features and general improvements

Feel free to check out the [Strapi GitHub repository](https://github.com/strapi/strapi). Your feedback and contributions are welcome!

## ✨ Community

- [Discord](https://discord.strapi.io) - Come chat with the Strapi community including the core team
- [Forum](https://forum.strapi.io/) - Place to discuss, ask questions and find answers, show your Strapi project and get feedback or just talk with other Community members
- [Awesome Strapi](https://github.com/strapi/awesome-strapi) - A curated list of awesome things related to Strapi

## 📝 License

This project is based on the Strapi Cloud editorial template and is available for use in building news and editorial websites.

---

<sub>🤫 Psst! [Strapi is hiring](https://strapi.io/careers).</sub>