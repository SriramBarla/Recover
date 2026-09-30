// Category words and icons. Labels are plain words a student would use.
// High-value categories (phone, wallet, keys, ID, medication) are "take it to the office" only.
import type { Category } from '@recover/shared/dto.ts';
import {
  IconBag,
  IconBook,
  IconBottle,
  IconClothing,
  IconElectronics,
  IconId,
  IconJewelry,
  IconKeys,
  IconMedication,
  IconOther,
  IconPhone,
  IconSports,
  IconWallet,
  type IconProps,
} from './icons.tsx';

export const CATEGORY_LABEL: Record<Category, string> = {
  bag: 'Bag or backpack',
  clothing: 'Clothing',
  bottle: 'Water bottle',
  book: 'Book or binder',
  electronics_low: 'Small electronics',
  jewelry: 'Jewelry',
  sports: 'Sports gear',
  other: 'Something else',
  phone: 'Phone',
  wallet: 'Wallet or purse',
  keys: 'Keys',
  id_card: 'ID card',
  medication: 'Medication',
};

// One-line examples for category tiles.
export const CATEGORY_HINT: Record<Category, string> = {
  bag: 'Backpacks, lunch bags, pencil cases',
  clothing: 'Jackets, hoodies, hats',
  bottle: 'Water bottles and cups',
  book: 'Books, binders, notebooks',
  electronics_low: 'Earbuds, chargers, calculators',
  jewelry: 'Rings, necklaces, bracelets',
  sports: 'Balls, gloves, gym gear',
  other: 'Anything not listed',
  phone: 'Take it to the office',
  wallet: 'Take it to the office',
  keys: 'Take it to the office',
  id_card: 'Take it to the office',
  medication: 'Take it to the office',
};

// Short forms for chips, table cells, and card overlays.
export const CATEGORY_SHORT: Record<Category, string> = {
  bag: 'Bag',
  clothing: 'Clothing',
  bottle: 'Bottle',
  book: 'Book',
  electronics_low: 'Electronics',
  jewelry: 'Jewelry',
  sports: 'Sports',
  other: 'Other',
  phone: 'Phone',
  wallet: 'Wallet',
  keys: 'Keys',
  id_card: 'ID card',
  medication: 'Medication',
};

function isCategory(c: string): c is Category {
  return Object.prototype.hasOwnProperty.call(CATEGORY_LABEL, c);
}

export function categoryLabel(c: string | null | undefined, short = false): string {
  if (!c || !isCategory(c)) return 'Item';
  return short ? CATEGORY_SHORT[c] : CATEGORY_LABEL[c];
}

export function CategoryIcon({ category, ...p }: IconProps & { category: string | null | undefined }) {
  switch (category) {
    case 'bag':
      return <IconBag {...p} />;
    case 'clothing':
      return <IconClothing {...p} />;
    case 'bottle':
      return <IconBottle {...p} />;
    case 'book':
      return <IconBook {...p} />;
    case 'electronics_low':
      return <IconElectronics {...p} />;
    case 'jewelry':
      return <IconJewelry {...p} />;
    case 'sports':
      return <IconSports {...p} />;
    case 'phone':
      return <IconPhone {...p} />;
    case 'wallet':
      return <IconWallet {...p} />;
    case 'keys':
      return <IconKeys {...p} />;
    case 'id_card':
      return <IconId {...p} />;
    case 'medication':
      return <IconMedication {...p} />;
    default:
      return <IconOther {...p} />;
  }
}
