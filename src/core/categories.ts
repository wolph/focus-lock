import forums from '../lists/forums.json';
import gaming from '../lists/gaming.json';
import mail from '../lists/mail.json';
import news from '../lists/news.json';
import shopping from '../lists/shopping.json';
import social from '../lists/social.json';
import video from '../lists/video.json';
import type { CategoryId, CategoryList } from '../shared/types';
import { categoryLabel } from '../shared/verdict-label';

/** Bundled category lists, options UI order. */
export const ALL_CATEGORIES: CategoryList[] = [
  social,
  video,
  news,
  mail,
  shopping,
  gaming,
  forums,
] as CategoryList[];

/**
 * One category with its translated title. The bundled JSON keeps the English title as the record
 * key the lists are authored under, and the UI reads this instead.
 */
export function localizedCategory(category: CategoryList): CategoryList {
  return { ...category, title: categoryLabel(category.id as CategoryId) };
}

/** The bundled categories in options order, each carrying its translated title. */
export function localizedCategories(): CategoryList[] {
  return ALL_CATEGORIES.map(localizedCategory);
}
