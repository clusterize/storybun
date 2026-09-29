import type { ReportTemplateProps } from "../report-html.tsx";

/** A minimal custom template: one line per entry, no images. */
export default function Report({ report, imagePrefix }: ReportTemplateProps) {
  return (
    <html lang="en">
      <body data-image-prefix={imagePrefix}>
        <h1>custom template</h1>
        <ul>
          {report.results.map((r, i) => (
            <li key={i}>
              {r.storyKey}: {r.status}
            </li>
          ))}
        </ul>
      </body>
    </html>
  );
}
