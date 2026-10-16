/**
 * Google Fonts families offered as suggestions in the pickers (the picker
 * still accepts free text: ANY Google Font works by typing its name). Lives
 * in the schema because both the web app (suggestions) and the renderer
 * (css2 link canonicalization) need it.
 */
export const GOOGLE_FONTS: string[] = [
  "Inter", "Roboto", "Roboto Condensed", "Roboto Slab", "Roboto Mono", "Open Sans",
  "Lato", "Montserrat", "Montserrat Alternates", "Poppins", "Raleway", "Nunito",
  "Nunito Sans", "Work Sans", "Source Sans 3", "Source Serif 4", "Source Code Pro",
  "Rubik", "Mulish", "Manrope", "DM Sans", "DM Serif Display", "DM Serif Text",
  "DM Mono", "Karla", "Quicksand", "Josefin Sans", "Josefin Slab", "Barlow",
  "Barlow Condensed", "Barlow Semi Condensed", "Kanit", "Oswald", "Bebas Neue",
  "Archivo", "Archivo Black", "Archivo Narrow", "Space Grotesk", "Space Mono",
  "Figtree", "Plus Jakarta Sans", "Outfit", "Sora", "Lexend", "Lexend Deca",
  "Playfair Display", "Playfair Display SC", "Merriweather", "Merriweather Sans",
  "Lora", "PT Serif", "PT Sans", "PT Sans Narrow", "Cormorant", "Cormorant Garamond",
  "EB Garamond", "Libre Baskerville", "Libre Franklin", "Crimson Text", "Crimson Pro",
  "Bitter", "Zilla Slab", "Noto Sans", "Noto Serif", "Fira Sans", "Fira Sans Condensed",
  "Fira Code", "Fira Mono", "IBM Plex Sans", "IBM Plex Serif", "IBM Plex Mono",
  "Titillium Web", "Cabin", "Cabin Condensed", "Dosis", "Hind", "Hind Siliguri",
  "Heebo", "Assistant", "Overpass", "Overpass Mono", "Red Hat Display", "Red Hat Text",
  "Red Hat Mono", "Signika", "Signika Negative", "Exo", "Exo 2", "Teko", "Anton",
  "Alfa Slab One", "Righteous", "Fredoka", "Comfortaa", "Baloo 2", "Bree Serif",
  "Abril Fatface", "Yeseva One", "Sacramento", "Great Vibes", "Dancing Script",
  "Pacifico", "Caveat", "Satisfy", "Kaushan Script", "Lobster", "Lobster Two",
  "Shadows Into Light", "Indie Flower", "Amatic SC", "Permanent Marker", "Courgette",
  "Cookie", "Parisienne", "Allura", "Tangerine", "Marck Script", "Yellowtail",
  "Cinzel", "Cinzel Decorative", "Marcellus", "Marcellus SC", "Prata", "Philosopher",
  "Alegreya", "Alegreya Sans", "Alegreya SC", "Vollkorn", "Spectral", "Domine",
  "Frank Ruhl Libre", "Bodoni Moda", "Fraunces", "Newsreader", "Petrona", "Rozha One",
  "Jost", "Urbanist", "Epilogue", "Onest", "Instrument Sans",
  "Instrument Serif", "Schibsted Grotesk", "Bricolage Grotesque", "Hanken Grotesk",
  "Albert Sans", "Be Vietnam Pro", "Chivo", "Chivo Mono", "Public Sans", "Rethink Sans",
  "Geist", "Geist Mono", "Gabarito", "Gantari", "Readex Pro", "Sen", "Syne",
  "Unbounded", "Clash Display", "Familjen Grotesk", "General Sans", "Zodiak",
  "Tektur", "League Spartan", "League Gothic", "Big Shoulders Display", "Bungee",
  "Monoton", "Orbitron", "Audiowide", "Press Start 2P", "VT323", "Rajdhani",
  "Saira", "Saira Condensed", "Saira Semi Condensed", "Michroma", "Chakra Petch",
  "Prompt", "Mitr", "Sarabun", "Mali", "Krub", "Maven Pro", "Muli", "News Cycle",
  "Arvo", "Slabo 27px", "Slabo 13px", "Cardo", "Neuton", "Gelasio", "Tinos",
  "Merienda", "Pattaya", "Sniglet", "Concert One", "Fugaz One", "Passion One",
  "Staatliches", "Rye", "Special Elite", "Cutive Mono", "JetBrains Mono",
  "Ubuntu", "Ubuntu Condensed", "Ubuntu Mono", "Varela Round", "Varela",
  "Questrial", "Julius Sans One", "Advent Pro", "Syncopate",
  "Bevan", "Bangers", "Luckiest Guy", "Ultra", "Bowlby One", "Bowlby One SC",
  "Titan One", "Chewy", "Shrikhand", "Secular One", "Changa", "Changa One",
];

const BY_LOWER = new Map(GOOGLE_FONTS.map((f) => [f.toLowerCase(), f]));

/**
 * Canonicalizes a Google family name: the css2 API is CASE-SENSITIVE
 * ("bevan" → 400 and the WHOLE stylesheet fails, taking the page's other
 * fonts down too). Matches the list (any case); names outside the list
 * written all lowercase get Title Case per word (Google convention).
 * Names with explicit capitals pass unchanged.
 */
export function canonicalFontFamily(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return trimmed;
  const hit = BY_LOWER.get(trimmed.toLowerCase());
  if (hit) return hit;
  if (trimmed === trimmed.toLowerCase()) {
    return trimmed.replace(/(^|\s)\S/g, (c) => c.toUpperCase());
  }
  return trimmed;
}
