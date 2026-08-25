import { FileText } from "lucide-react";

function Reports() {
  return (
    <main className="page-content">
      <div className="page-heading">
        <p className="eyebrow">SALVAGE REPORT</p>
        <h3>Reports</h3>
        <p>
          Your PCB analysis and salvage recommendations will be
          summarized here.
        </p>
      </div>

      <div className="empty-state">
        <FileText size={32} />

        <h4>No reports generated yet</h4>

        <p>
          Complete a PCB analysis to generate a salvage report.
        </p>
      </div>
    </main>
  );
}

export default Reports;