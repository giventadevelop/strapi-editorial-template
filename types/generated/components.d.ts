import type { Schema, Struct } from '@strapi/strapi';

export interface DirectorySectionCard extends Struct.ComponentSchema {
  collectionName: 'components_directory_section_cards';
  info: {
    description: 'Image, title, description and link for a directory section (e.g. Bishops, Dioceses)';
    displayName: 'Section Card';
    icon: 'picture';
    name: 'Section Card';
  };
  attributes: {
    description: Schema.Attribute.Text;
    image: Schema.Attribute.Media<'images'>;
    linkUrl: Schema.Attribute.String;
    title: Schema.Attribute.String & Schema.Attribute.Required;
  };
}

export interface LiturgyReading extends Struct.ComponentSchema {
  collectionName: 'components_liturgy_readings';
  info: {
    description: 'A single liturgical reading with bilingual heading and reference';
    displayName: 'Reading';
  };
  attributes: {
    contentPlaceEn: Schema.Attribute.RichText &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 500;
      }>;
    contentPlaceMalylm: Schema.Attribute.RichText &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 500;
      }>;
    liturgyHeadingEn: Schema.Attribute.RichText &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 500;
      }>;
    liturgyHeadingMalylm: Schema.Attribute.RichText &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 500;
      }>;
  };
}

export interface SharedMedia extends Struct.ComponentSchema {
  collectionName: 'components_shared_media';
  info: {
    displayName: 'Media';
    icon: 'file-video';
  };
  attributes: {
    file: Schema.Attribute.Media<'images' | 'files' | 'videos'>;
  };
}

export interface SharedQuote extends Struct.ComponentSchema {
  collectionName: 'components_shared_quotes';
  info: {
    displayName: 'Quote';
    icon: 'indent';
  };
  attributes: {
    body: Schema.Attribute.Text;
    title: Schema.Attribute.String;
  };
}

export interface SharedRichText extends Struct.ComponentSchema {
  collectionName: 'components_shared_rich_texts';
  info: {
    description: '';
    displayName: 'Rich text';
    icon: 'align-justify';
  };
  attributes: {
    body: Schema.Attribute.RichText;
  };
}

export interface SharedSeo extends Struct.ComponentSchema {
  collectionName: 'components_shared_seos';
  info: {
    description: '';
    displayName: 'Seo';
    icon: 'allergies';
    name: 'Seo';
  };
  attributes: {
    metaDescription: Schema.Attribute.Text & Schema.Attribute.Required;
    metaTitle: Schema.Attribute.String & Schema.Attribute.Required;
    shareImage: Schema.Attribute.Media<'images'>;
  };
}

export interface SharedSlider extends Struct.ComponentSchema {
  collectionName: 'components_shared_sliders';
  info: {
    description: '';
    displayName: 'Slider';
    icon: 'address-book';
  };
  attributes: {
    files: Schema.Attribute.Media<'images', true>;
  };
}

declare module '@strapi/strapi' {
  export module Public {
    export interface ComponentSchemas {
      'directory.section-card': DirectorySectionCard;
      'liturgy.reading': LiturgyReading;
      'shared.media': SharedMedia;
      'shared.quote': SharedQuote;
      'shared.rich-text': SharedRichText;
      'shared.seo': SharedSeo;
      'shared.slider': SharedSlider;
    }
  }
}
