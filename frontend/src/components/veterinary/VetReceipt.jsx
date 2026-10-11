import React, { useState, useEffect } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faPrint,
  faDownload,
  faTimes,
  faFileInvoice,
  faSpinner,
} from "@fortawesome/free-solid-svg-icons";
import { apiRequest } from "../../api/client";
import { formatCurrency } from "../../utils/currency";
import { STORE_INFO, computeVatBreakdown } from "../../utils/storeInfo";
import jsPDF from "jspdf";
import html2canvas from "html2canvas";
import { showError } from "../../utils/alert.jsx";
import "./theme.css";
import "./VetReceipt.css";

const VetReceipt = () => {
  const [receiptData, setReceiptData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const id = urlParams.get('id');
    if (id) {
      fetchReceipt(id);
    } else {
      setLoading(false);
    }
  }, []);

  const fetchReceipt = async (id) => {
    try {
      setLoading(true);
      const data = await apiRequest(`/veterinary/receipt/${id}`);
      const receipt = data?.receipt || data;

      if (!receipt || typeof receipt !== "object") {
        throw new Error("Receipt not found");
      }

      setReceiptData({
        id: receipt.id,
        date: receipt.date,
        time: new Date(receipt.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        service_type: receipt.service_name || 'service',
        vet_name: receipt.vet_name || 'Unknown',
        pet_name: receipt.pet_name || 'Unknown',
        owner_name: receipt.customer_name || 'Unknown',
        service_name: receipt.service_name || 'Service',
        service_cost: receipt.amount || 0,
        description: receipt.notes || 'No description',
        subtotal: receipt.subtotal || receipt.amount || 0,
        tax: receipt.tax || receipt.vat_amount || 0,
        total: receipt.total || receipt.amount || 0,
        payment_method: receipt.payment_method || 'cash',
        payment_status: receipt.status || 'pending',
        receipt_number: receipt.receipt_number || null,
        paid_date: receipt.paid_date || null,
        pet_breed: receipt.pet_breed || null,
        pet_age: receipt.pet_age || null,
        additional_services: receipt.additional_services || [],
      });
      setError("");
    } catch (err) {
      setError(err.message || "Failed to fetch receipt");
      showError(err.message || "Failed to fetch receipt");
      console.error("Receipt fetch error:", err);
    } finally {
      setLoading(false);
    }
  };

  const handlePrint = () => {
    window.print();
  };

  const handleDownloadPDF = async () => {
    try {
      if (!receiptData) return;
      const element = document.getElementById("receipt-content");
      const canvas = await html2canvas(element, { scale: 2 });
      const imgData = canvas.toDataURL("image/png");
      const pdf = new jsPDF("p", "mm", "a4");
      const width = pdf.internal.pageSize.getWidth();
      pdf.addImage(imgData, "PNG", 10, 10, width - 20, 0);
      pdf.save(`receipt-${receiptData.id}.pdf`);
    } catch (err) {
      setError("Failed to download PDF");
      showError("Failed to download PDF");
      console.error(err);
    }
  };

  const handleClose = () => {
    setReceiptData(null);
    window.history.back();
  };

  if (loading) {
    return (
      <section className="app-content vet-receipt">
        <div className="vr-status">
          <FontAwesomeIcon icon={faSpinner} spin />
          <span>Loading receipt…</span>
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section className="app-content vet-receipt">
        <div className="vr-status vr-status--error">
          <span>⚠ {error}</span>
        </div>
      </section>
    );
  }

  if (!receiptData) {
    return (
      <section className="app-content vet-receipt">
        <div className="vr-status">
          <FontAwesomeIcon icon={faFileInvoice} style={{ fontSize: "2rem" }} />
          <h3>No receipt selected</h3>
          <p>Please select a receipt from the reports page.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="app-content vet-receipt">

      {/* ── Captured area for PDF ── */}
      <div className="vr-paper" id="receipt-content">

        {/* Store header */}
        <div className="vr-hd">
          <div className="vr-name">{STORE_INFO.name.toUpperCase()}</div>
          {STORE_INFO.address.split("\n").map((line) => (
            <div className="vr-addr" key={line}>{line}</div>
          ))}
          <div className="vr-email">{STORE_INFO.email}</div>
          <div className="vr-title">SERVICE INVOICE</div>
        </div>

        {/* Transaction info */}
        <div className="vr-row"><span>Receipt #</span><span>{receiptData.id}</span></div>
        <div className="vr-row"><span>Date</span><span>{new Date(receiptData.date).toLocaleDateString()}</span></div>
        <div className="vr-row"><span>Time</span><span>{receiptData.time}</span></div>
        <div className="vr-row"><span>Type</span><span>{receiptData.service_type?.toUpperCase()}</span></div>
        <div className="vr-row"><span>Veterinarian</span><span>Dr. {receiptData.vet_name}</span></div>


        {/* Patient info */}
        <div className="vr-row"><span>Pet Name</span><span>{receiptData.pet_name}</span></div>
        <div className="vr-row"><span>Owner</span><span>{receiptData.owner_name}</span></div>
        <div className="vr-row"><span>Breed</span><span>{receiptData.pet_breed || "N/A"}</span></div>
        <div className="vr-row"><span>Age</span><span>{receiptData.pet_age || "N/A"}</span></div>


        {/* Service items */}
        <div className="vr-item">
          <div className="vr-item-name">{receiptData.service_name}</div>
          <div className="vr-item-desc">{receiptData.description}</div>
          <div className="vr-item-price">{formatCurrency(receiptData.service_cost)}</div>
        </div>

        {receiptData.additional_services.length > 0 && (
          <>
    
            <div className="vr-section-label">ADDITIONAL SERVICES</div>
            {receiptData.additional_services.map((svc, i) => (
              <div className="vr-item" key={i}>
                <div className="vr-item-name">{svc.name}</div>
                <div className="vr-item-price">{formatCurrency(svc.cost)}</div>
              </div>
            ))}
          </>
        )}


        {/* Totals */}
        <div className="vr-row"><span>Subtotal (incl. VAT)</span><span>{formatCurrency(receiptData.subtotal)}</span></div>
        <div className="vr-row"><span>VAT 12%</span><span>-{formatCurrency(Math.abs(Number(receiptData.tax || computeVatBreakdown(receiptData.total).vatAmount) || 0))}</span></div>
        <div className="vr-total">
          <span>TOTAL</span>
          <span>{formatCurrency(receiptData.total)}</span>
        </div>

        {/* Payment info */}
        <div className="vr-row"><span>Payment Method</span><span>{receiptData.payment_method?.toUpperCase()}</span></div>
        <div className="vr-row"><span>Status</span><span>{receiptData.payment_status?.toUpperCase()}</span></div>
        {receiptData.paid_date && (
          <div className="vr-row"><span>Paid on</span><span>{new Date(receiptData.paid_date).toLocaleDateString()}</span></div>
        )}


        {/* Footer */}
        <div className="vr-footer">
          <p>Thank you for trusting {STORE_INFO.name}<br />with your pet's health!</p>
        </div>

      </div>
      {/* ── End captured area ── */}

      {/* Action buttons — screen only, excluded from PDF/print */}
      <div className="vr-actions">
        <button className="vr-btn vr-btn--primary" onClick={handlePrint}>
          <FontAwesomeIcon icon={faPrint} /> Print
        </button>
        <button className="vr-btn vr-btn--secondary" onClick={handleDownloadPDF}>
          <FontAwesomeIcon icon={faDownload} /> Download PDF
        </button>
        <button className="vr-btn vr-btn--ghost" onClick={handleClose}>
          <FontAwesomeIcon icon={faTimes} /> Close
        </button>
      </div>

    </section>
  );
};

export default VetReceipt;
