import { buttonVariants } from '@amable/ui/ui/button';
import { Download } from 'lucide-react';

export interface CsvExportButtonProps {
  /** `reports:export` of the active membership: without it nothing renders. */
  readonly canExport: boolean;
  /** Download URL (`exportCsvUrl`); null when the report cannot be exported (unsaved preview). */
  readonly href: string | null;
  readonly label: string;
}

/** Plain same-origin link: the browser streams the CSV with the session cookie. */
export function CsvExportButton({ canExport, href, label }: CsvExportButtonProps) {
  if (!canExport || href === null) return null;
  return (
    <a
      href={href}
      download
      data-testid="report-csv-export"
      className={buttonVariants({ variant: 'outline', size: 'sm' })}
    >
      <Download className="size-3.5" aria-hidden />
      {label}
    </a>
  );
}
