# News Article Cover Image – Strapi Upload Spec

Recommendations for uploading article cover images to Strapi so they display well in both the listing cards and the detail page hero.

## Display Contexts

| Context | Max display width | Aspect used |
|---------|-------------------|-------------|
| **List card** (2-col grid) | ~400px | Full image shown (`object-contain`) |
| **List card** (compact/Most Read) | ~672px | Full image shown |
| **Detail hero** | 896px | Full image shown (`object-contain`) |

## Recommended Upload Specs

### Dimensions

| Use case | Recommended size | Aspect ratio |
|----------|------------------|--------------|
| **Primary (covers both)** | **1200 × 800 px** | 3:2 |
| Alternative (list-optimized) | 1200 × 900 px | 4:3 |
| Alternative (hero-optimized) | 1200 × 675 px | 16:9 |

**1200 × 800 px (3:2)** is a good default: sharp on retina, works in both list and hero, and keeps faces/subjects visible.

### Format

- **JPEG** – preferred for photos (quality/size balance)
- **WebP** – if supported by your Strapi setup
- **PNG** – only for graphics or images with transparency

### Quality & File Size

- **JPEG quality**: 80–85%
- **Target file size**: &lt; 200 KB per image (under 300 KB max)
- **Colour**: sRGB

### Composition Tips

- Put faces and important content in the upper half of the image (list cards show the full image; header area is no longer cropped).
- Avoid text or logos near the edges.
- Use a neutral background so letterboxing is less noticeable when aspect ratios differ.

## Summary

**Upload to Strapi**: **1200 × 800 px**, JPEG, 80–85% quality, &lt; 200 KB.
Images are shown full (`object-contain`), so no important content is cropped in list or hero views.
