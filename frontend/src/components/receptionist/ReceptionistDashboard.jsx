import React, { useEffect, useMemo, useState } from "react";
import { showConfirm, showWarning, showError, showSuccess, showReasonPrompt, BOOKING_REJECT_REASONS } from "../../utils/alert.jsx";
import {
  FaCalendarAlt,
  FaCalendarCheck,
  FaCashRegister,
  FaCheckCircle,
  FaClock,
  FaCut,
  FaDownload,
  FaEye,
  FaHotel,
  FaInfoCircle,
  FaPaw,
  FaSearch,
  FaSort,
  FaSortDown,
  FaSortUp,
  FaSpinner,
  FaStethoscope,
  FaSyncAlt,
  FaTimes,
  FaTimesCircle,
  FaUndoAlt,
  FaUser,
  FaWrench,
} from "react-icons/fa";
import { apiRequest, getAuthenticatedFileUrl } from "../../api/client";
import RowActionPopover from "../shared/RowActionPopover";
import { exportToCSV, exportToPDF, exportToExcel } from "../../utils/reportExport";
import ServiceManagerModal from "./ServiceManagerModal";
import "../../styles/bookingModal.css";
import "./ReceptionistDashboard.css";

const STATUS_OPTIONS = [
  { value: "all", label: "All Status" },
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
];

const TYPE_OPTIONS = [
  { value: "all", label: "All Services" },
  { value: "vet", label: "Veterinary" },
  { value: "grooming", label: "Grooming" },
  { value: "hotel", label: "Hotel / Boarding" },
];

const PAYMENT_OPTIONS = [
  { value: "all", label: "All Payments" },
  { value: "pending", label: "Pending" },
  { value: "unpaid", label: "Unpaid" },
  { value: "paid", label: "Paid" },
];

const safeText = (value) => String(value || "").toLowerCase();

const ReceptionistDashboard = () => {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [lastUpdated, setLastUpdated] = useState("");

  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [paymentFilter, setPaymentFilter] = useState("all");

  const [selectedRequest, setSelectedRequest] = useState(null);
  const [showServiceManager, setShowServiceManager] = useState(false);
  const [busyAction, setBusyAction] = useState("");
  const [showExportDropdown, setShowExportDropdown] = useState(false);
  const [sortConfig, setSortConfig] = useState({
    key: "created_at",
    direction: "desc",
  });

  const notify = (type, message) => {
    if (type === "success") {
      setSuccess(message);
      window.clearTimeout(window.receptionistSuccessTimer);
      window.receptionistSuccessTimer = window.setTimeout(() => setSuccess(""), 3000);
      showSuccess(message);
      return;
    }

    setError(message);
    window.clearTimeout(window.receptionistErrorTimer);
    window.receptionistErrorTimer = window.setTimeout(() => setError(""), 5000);
    showError(message);
  };

  const normalizeType = (value = "") => {
    const type = String(value || "").toLowerCase();

    if (type.includes("groom")) return "grooming";
    if (type.includes("hotel") || type.includes("boarding") || type.includes("board")) return "hotel";
    if (type.includes("vet") || type.includes("medical") || type.includes("consult")) return "vet";

    return type || "service";
  };

  const normalizePayment = (value = "") => {
    const payment = String(value || "").toLowerCase();

    if (payment === "paid" || payment === "verified" || payment === "completed") return "paid";
    if (payment === "unpaid") return "unpaid";
    if (payment === "pending" || payment === "for_payment" || payment === "for payment") return "pending";

    return "pending";
  };

  const normalizeStatus = (value = "") => {
    const status = String(value || "").toLowerCase();

    if (status === "approved" || status === "scheduled" || status === "confirmed") return "approved";
    if (status === "rejected" || status === "cancelled" || status === "canceled") return "rejected";

    return status || "pending";
  };

  const normalizeRequests = (payload) => {
    const list = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.requests)
      ? payload.requests
      : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.data?.requests)
      ? payload.data.requests
      : [];

    return list.map((item, index) => {
      const rawId = item.id || item.request_id || item.service_request_id || index + 1;
      const type = normalizeType(item.type || item.service_type || item.source || item.category);
      const status = normalizeStatus(item.status);
      const payment = normalizePayment(item.payment || item.payment_status);

      return {
        rawId,
        id: `REQ-${rawId}`,
        customer:
          item.customer ||
          item.customer_name ||
          item.client_name ||
          item.user?.name ||
          "Unknown Customer",
        pet:
          item.pet ||
          item.pet_name ||
          item.pet?.name ||
          item.petName ||
          "No pet listed",
        service:
          item.service ||
          item.service_name ||
          item.name ||
          item.package_name ||
          "Service Request",
        type,
        date:
          item.date ||
          item.booking_date ||
          item.appointment_date ||
          item.schedule_date ||
          item.scheduled_date ||
          item.created_at ||
          "",
        time:
          item.time ||
          item.booking_time ||
          item.appointment_time ||
          item.schedule_time ||
          item.scheduled_time ||
          "",
        status,
        payment,
        notes:
          item.notes ||
          item.remarks ||
          item.special_request ||
          item.special_requests ||
          item.description ||
          "",
        created_at: item.created_at || item.date || "",
        vaccination_card: item.vaccination_card || null,
        vaccination_card_url: item.vaccination_card_url || null,
        vaccination_card_verified_at: item.vaccination_card_verified_at || null,
        raw: item,
      };
    });
  };

  const fetchRequests = async ({ silent = false } = {}) => {
    try {
      if (silent) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }

      setError("");

      const data = await apiRequest("/receptionist/requests", {
        method: "GET",
      });

      setRequests(normalizeRequests(data));
      setLastUpdated(new Date().toLocaleString("en-PH"));
    } catch (err) {
      console.error("Fetch requests error:", err);
      notify("error", err.message || "Failed to load requests.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchRequests();
  }, []);

  const stats = useMemo(() => {
    const pending = requests.filter((item) => item.status === "pending").length;
    const approved = requests.filter((item) => item.status === "approved").length;
    const rejected = requests.filter((item) => item.status === "rejected").length;
    const forPayment = requests.filter(
      (item) => item.payment === "pending" || item.payment === "unpaid"
    ).length;

    return {
      total: requests.length,
      pending,
      approved,
      rejected,
      forPayment,
    };
  }, [requests]);

  const filteredRequests = useMemo(() => {
    const keyword = safeText(searchTerm);

    return requests.filter((item) => {
      const matchesSearch =
        !keyword ||
        safeText(item.id).includes(keyword) ||
        safeText(item.customer).includes(keyword) ||
        safeText(item.pet).includes(keyword) ||
        safeText(item.service).includes(keyword) ||
        safeText(item.type).includes(keyword) ||
        safeText(item.status).includes(keyword) ||
        safeText(item.payment).includes(keyword);

      const matchesStatus = statusFilter === "all" || item.status === statusFilter;
      const matchesType = typeFilter === "all" || item.type === typeFilter;
      const matchesPayment = paymentFilter === "all" || item.payment === paymentFilter;

      return matchesSearch && matchesStatus && matchesType && matchesPayment;
    });
  }, [requests, searchTerm, statusFilter, typeFilter, paymentFilter]);

  const sortedRequests = useMemo(() => {
    const list = [...filteredRequests];

    list.sort((a, b) => {
      const multiplier = sortConfig.direction === "asc" ? 1 : -1;

      let aValue = a[sortConfig.key];
      let bValue = b[sortConfig.key];

      if (sortConfig.key === "date" || sortConfig.key === "created_at") {
        aValue = aValue ? new Date(aValue).getTime() : 0;
        bValue = bValue ? new Date(bValue).getTime() : 0;
      }

      if (typeof aValue === "number" && typeof bValue === "number") {
        return (aValue - bValue) * multiplier;
      }

      return String(aValue || "").localeCompare(String(bValue || "")) * multiplier;
    });

    return list;
  }, [filteredRequests, sortConfig]);

  const updateStatus = async (request, newStatus) => {
    if (!request?.rawId) {
      notify("error", "Invalid request ID.");
      return;
    }

    let rejectionReason = null;
    if (newStatus === "rejected") {
      rejectionReason = await showReasonPrompt(
        `Reject ${request.id}? Please select a reason.`,
        "Reject Request",
        "Reject",
        BOOKING_REJECT_REASONS
      );
      if (!rejectionReason) return;
    }

    const actionKey = `${request.rawId}-${newStatus}`;

    try {
      setBusyAction(actionKey);

      await apiRequest(`/receptionist/requests/${request.rawId}/status`, {
        method: "PATCH",
        body: JSON.stringify({
          status: newStatus,
          ...(rejectionReason ? { rejection_reason: rejectionReason } : {}),
        }),
      });

      setRequests((prev) =>
        prev.map((item) =>
          item.rawId === request.rawId ? { ...item, status: newStatus } : item
        )
      );

      setSelectedRequest((prev) =>
        prev?.rawId === request.rawId ? { ...prev, status: newStatus } : prev
      );

      notify("success", `${request.id} marked as ${newStatus}.`);
      fetchRequests({ silent: true });
    } catch (err) {
      console.error("Update status error:", err);
      notify("error", err.message || "Failed to update request status.");
    } finally {
      setBusyAction("");
    }
  };

  const clearFilters = () => {
    setSearchTerm("");
    setStatusFilter("all");
    setTypeFilter("all");
    setPaymentFilter("all");
  };

  const exportColumns = [
    { key: "id", label: "Request ID" },
    { key: "customer", label: "Customer" },
    { key: "pet", label: "Pet" },
    { key: "service", label: "Service" },
    { key: "type", label: "Type" },
    { key: "date", label: "Date" },
    { key: "time", label: "Time" },
    { key: "status", label: "Status" },
    { key: "payment", label: "Payment" },
    { key: "notes", label: "Notes" },
  ];

  const handleExport = (format) => {
    setShowExportDropdown(false);
    if (sortedRequests.length === 0) {
      notify("error", "No receptionist requests to export.");
      return;
    }

    const filename = "receptionist-requests";
    if (format === "csv") exportToCSV(sortedRequests, exportColumns, filename);
    else if (format === "excel") exportToExcel(sortedRequests, exportColumns, filename);
    else if (format === "pdf") exportToPDF(sortedRequests, exportColumns, "Receptionist Requests", filename);

    notify("success", "Receptionist requests exported.");
  };

  const formatDate = (value) => {
    if (!value) return "N/A";

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;

    return date.toLocaleDateString("en-PH", {
      year: "numeric",
      month: "short",
      day: "2-digit",
    });
  };

  const getServiceIcon = (type) => {
    if (type === "grooming") return <FaCut />;
    if (type === "hotel") return <FaHotel />;
    if (type === "vet") return <FaStethoscope />;
    return <FaPaw />;
  };

  const getSortIcon = (key) => {
    if (sortConfig.key !== key) return <FaSort />;
    return sortConfig.direction === "asc" ? <FaSortUp /> : <FaSortDown />;
  };

  const openVaccinationCard = async (url) => {
    if (!url) {
      showWarning("No vaccination card available");
      return;
    }

    const win = window.open("", "_blank");
    if (!win) {
      showError("Popup blocked. Please allow popups for this site.");
      return;
    }

    try {
      win.location.href = await getAuthenticatedFileUrl(url);
    } catch (err) {
      win.close();
      showError(err.message || "Failed to open vaccination card.");
    }
  };

  const handleSort = (key) => {
    setSortConfig((prev) => ({
      key,
      direction: prev.key === key && prev.direction === "asc" ? "desc" : "asc",
    }));
  };

  const isBusy = (request, status) => busyAction === `${request.rawId}-${status}`;

  const StatCard = ({ icon, label, value, active, onClick, tone }) => (
    <button
      type="button"
      className={`receptionist-stat-card ${active ? "active" : ""} ${tone || ""}`}
      onClick={onClick}
    >
      <span>{icon}</span>
      <div>
        <h3>{value}</h3>
        <p>{label}</p>
      </div>
    </button>
  );

  return (
    <div className="receptionist-dashboard">
      {success && (
        <div className="receptionist-toast success">
          <FaCheckCircle />
          <span>{success}</span>
        </div>
      )}

      {error && (
        <div className="receptionist-toast error">
          <FaTimesCircle />
          <span>{error}</span>
        </div>
      )}

      <section className="receptionist-hero fade-up">
        <div>
          <span className="hero-badge">
            <FaCalendarCheck />
            Receptionist Portal
          </span>

          <h1>Service Request Approval Center</h1>

          <p>
            Review customer bookings, approve valid service requests, reject invalid
            entries, and monitor payment readiness from one professional dashboard.
          </p>

          <small>Last updated: {lastUpdated || "Not refreshed yet"}</small>
        </div>

        <div className="hero-side-panel">
          <div className="hero-mini-card">
            <FaClock />
            <div>
              <strong>{stats.pending}</strong>
              <span>Pending Approvals</span>
            </div>
          </div>

          <div className="hero-action-group">
            <button
              type="button"
              className={`hero-action-btn ${refreshing ? "loading" : ""}`}
              onClick={() => fetchRequests({ silent: true })}
              disabled={refreshing}
            >
              {refreshing ? <FaSpinner /> : <FaSyncAlt />}
              {refreshing ? "Refreshing..." : "Refresh"}
            </button>

            <div className="export-dropdown-wrapper" style={{ position: "relative" }}>
              <button type="button" className="hero-action-btn ghost" onClick={() => setShowExportDropdown(!showExportDropdown)}>
                <FaDownload />
                Export ▼
              </button>
              {showExportDropdown && (
                <>
                  <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, zIndex: 998 }} onClick={() => setShowExportDropdown(false)} />
                  <div style={{ position: "absolute", top: "100%", right: 0, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,0.12)", zIndex: 999, minWidth: 160, overflow: "hidden" }}>
                    <button type="button" className="hero-action-btn ghost" style={{ width: "100%", justifyContent: "flex-start" }} onClick={() => handleExport("csv")}>Export as CSV</button>
                    <button type="button" className="hero-action-btn ghost" style={{ width: "100%", justifyContent: "flex-start" }} onClick={() => handleExport("excel")}>Export as Excel</button>
                    <button type="button" className="hero-action-btn ghost" style={{ width: "100%", justifyContent: "flex-start" }} onClick={() => handleExport("pdf")}>Export as PDF</button>
                  </div>
                </>
              )}
            </div>

            <button type="button" className="hero-action-btn" onClick={() => setShowServiceManager(true)}>
              <FaWrench />
              Manage Services & Rooms
            </button>
          </div>
        </div>
      </section>

      <section className="receptionist-stats">
        <StatCard
          icon={<FaPaw />}
          label="Total Requests"
          value={stats.total}
          active={statusFilter === "all" && paymentFilter === "all"}
          onClick={() => {
            setStatusFilter("all");
            setPaymentFilter("all");
          }}
        />

        <StatCard
          icon={<FaClock />}
          label="Pending"
          value={stats.pending}
          tone="warning"
          active={statusFilter === "pending"}
          onClick={() => setStatusFilter("pending")}
        />

        <StatCard
          icon={<FaCheckCircle />}
          label="Approved"
          value={stats.approved}
          tone="success"
          active={statusFilter === "approved"}
          onClick={() => setStatusFilter("approved")}
        />

        <StatCard
          icon={<FaTimesCircle />}
          label="Rejected"
          value={stats.rejected}
          tone="danger"
          active={statusFilter === "rejected"}
          onClick={() => setStatusFilter("rejected")}
        />

        <StatCard
          icon={<FaCashRegister />}
          label="For Payment"
          value={stats.forPayment}
          tone="info"
          active={paymentFilter === "pending" || paymentFilter === "unpaid"}
          onClick={() => {
            setPaymentFilter("pending");
            setStatusFilter("all");
          }}
        />
      </section>

      <section className="receptionist-toolbar fade-up">
        <div className="receptionist-search">
          <input
            type="text"
            placeholder="Search request, customer, pet, service, status..."
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
          />

          {searchTerm && (
            <button type="button" onClick={() => setSearchTerm("")}>
              <FaTimes />
            </button>
          )}
        </div>

        <label className="receptionist-filter">
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
          >
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="receptionist-filter">
          <select
            value={typeFilter}
            onChange={(event) => setTypeFilter(event.target.value)}
          >
            {TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="receptionist-filter">
          <select
            value={paymentFilter}
            onChange={(event) => setPaymentFilter(event.target.value)}
          >
            {PAYMENT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <button type="button" className="clear-filter-btn" onClick={clearFilters}>
          <FaTimes />
          Clear
        </button>
      </section>

      <section className="request-table-card fade-up">
        <div className="table-header">
          <div>
            <span className="section-eyebrow">
              <FaCalendarAlt />
              Live Queue
            </span>

            <h2>Customer Requests</h2>

            <p>
              Showing <strong>{sortedRequests.length}</strong> of{" "}
              <strong>{requests.length}</strong> request(s).
            </p>
          </div>

          <div className="table-header-actions">
            <button type="button" onClick={() => fetchRequests({ silent: true })}>
              <FaSyncAlt />
              Refresh
            </button>

            <div className="export-dropdown-wrapper" style={{ position: "relative" }}>
              <button type="button" onClick={() => setShowExportDropdown(!showExportDropdown)}>
                <FaDownload />
                Export ▼
              </button>
              {showExportDropdown && (
                <>
                  <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, zIndex: 998 }} onClick={() => setShowExportDropdown(false)} />
                  <div style={{ position: "absolute", top: "100%", right: 0, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,0.12)", zIndex: 999, minWidth: 160, overflow: "hidden" }}>
                    <button type="button" style={{ width: "100%", textAlign: "left" }} onClick={() => handleExport("csv")}>Export as CSV</button>
                    <button type="button" style={{ width: "100%", textAlign: "left" }} onClick={() => handleExport("excel")}>Export as Excel</button>
                    <button type="button" style={{ width: "100%", textAlign: "left" }} onClick={() => handleExport("pdf")}>Export as PDF</button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {loading ? (
          <div className="receptionist-loading-state">
            <FaSpinner />
            <h3>Loading requests...</h3>
            <p>Please wait while receptionist service requests are loaded.</p>
          </div>
        ) : (
          <div className="table-scroll">
            <table className="request-table">
              <thead>
                <tr>
                  <th>
                    <button type="button" onClick={() => handleSort("id")}>
                      Request ID {getSortIcon("id")}
                    </button>
                  </th>
                  <th>
                    <button type="button" onClick={() => handleSort("service")}>
                      Service {getSortIcon("service")}
                    </button>
                  </th>
                  <th>
                    <button type="button" onClick={() => handleSort("customer")}>
                      Customer {getSortIcon("customer")}
                    </button>
                  </th>
                  <th>
                    <button type="button" onClick={() => handleSort("pet")}>
                      Pet {getSortIcon("pet")}
                    </button>
                  </th>
                  <th>
                    <button type="button" onClick={() => handleSort("date")}>
                      Schedule {getSortIcon("date")}
                    </button>
                  </th>
                  <th>
                    <button type="button" onClick={() => handleSort("status")}>
                      Status {getSortIcon("status")}
                    </button>
                  </th>
                  <th>
                    <button type="button" onClick={() => handleSort("payment")}>
                      Payment {getSortIcon("payment")}
                    </button>
                  </th>
                  <th>Actions</th>
                </tr>
              </thead>

              <tbody>
                {sortedRequests.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <span className="request-id">{item.id}</span>
                    </td>

                    <td>
                      <div className="service-cell">
                        <span>{getServiceIcon(item.type)}</span>
                        <div>
                          <strong>{item.service}</strong>
                          <small>{item.type}</small>
                        </div>
                      </div>
                    </td>

                    <td>
                      <div className="customer-cell">
                        <span>
                          <FaUser />
                        </span>
                        <strong>{item.customer}</strong>
                      </div>
                    </td>

                    <td>{item.pet}</td>

                    <td>
                      <strong>{formatDate(item.date)}</strong>
                      <small>{item.time || "No time set"}</small>
                    </td>

                    <td>
                      <span className={`status-pill ${item.status}`}>
                        {item.status}
                      </span>
                    </td>

                    <td>
                      <span className={`payment-pill ${item.payment}`}>
                        {item.payment}
                      </span>
                    </td>

                    <td>
                      <RowActionPopover rowLabel={item.pet || item.customer || item.id}>
                        <div className="table-actions">
                        <button
                          className="view"
                          type="button"
                          onClick={() => setSelectedRequest(item)}
                          title="View Details"
                        >
                          <FaEye />
                        </button>

                        <button
                          className="approve"
                          type="button"
                          onClick={() => updateStatus(item, "approved")}
                          title="Approve"
                          disabled={item.status === "approved" || Boolean(busyAction)}
                        >
                          {isBusy(item, "approved") ? <FaSpinner /> : <FaCheckCircle />}
                        </button>

                        <button
                          className="reject"
                          type="button"
                          onClick={() => updateStatus(item, "rejected")}
                          title="Reject"
                          disabled={item.status === "rejected" || Boolean(busyAction)}
                        >
                          {isBusy(item, "rejected") ? <FaSpinner /> : <FaTimesCircle />}
                        </button>

                        <button
                          className="reset"
                          type="button"
                          onClick={() => updateStatus(item, "pending")}
                          title="Back to Pending"
                          disabled={item.status === "pending" || Boolean(busyAction)}
                        >
                          {isBusy(item, "pending") ? <FaSpinner /> : <FaUndoAlt />}
                        </button>
                        </div>
                      </RowActionPopover>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {sortedRequests.length === 0 && (
              <div className="receptionist-empty-state">
                <FaSearch />
                <h3>No requests found</h3>
                <p>Try changing your search keyword, status, service, or payment filter.</p>
              </div>
            )}
          </div>
        )}
      </section>

      {showServiceManager && <ServiceManagerModal onClose={() => setShowServiceManager(false)} />}

      {selectedRequest && (
        <div
          className="hbk-overlay"
          onClick={() => setSelectedRequest(null)}
        >
          <div
            className="hbk-modal fade-up"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="hbk-head">
              <div>
                <span className="hero-badge">
                  <FaInfoCircle />
                  Request Details
                </span>
                <h2>{selectedRequest.id}</h2>
              </div>

              <button type="button" className="close-btn" onClick={() => setSelectedRequest(null)}>
                <FaTimes />
              </button>
            </div>

            <div className="hbk-body">
              <div className="request-detail-grid">
                <div>
                  <small>Customer</small>
                  <strong>{selectedRequest.customer}</strong>
                </div>

                <div>
                  <small>Pet</small>
                  <strong>{selectedRequest.pet}</strong>
                </div>

                <div>
                  <small>Service</small>
                  <strong>{selectedRequest.service}</strong>
                </div>

                <div>
                  <small>Service Type</small>
                  <strong>{selectedRequest.type}</strong>
                </div>

                <div>
                  <small>Date</small>
                  <strong>{formatDate(selectedRequest.date)}</strong>
                </div>

                <div>
                  <small>Time</small>
                  <strong>{selectedRequest.time || "No time set"}</strong>
                </div>

                <div>
                  <small>Status</small>
                  <span className={`status-pill ${selectedRequest.status}`}>
                    {selectedRequest.status}
                  </span>
                </div>

                <div>
                  <small>Payment</small>
                  <span className={`payment-pill ${selectedRequest.payment}`}>
                    {selectedRequest.payment}
                  </span>
                </div>
              </div>

              <div className="request-notes-card">
                <small>Notes</small>
                <p>{selectedRequest.notes || "No notes provided."}</p>
              </div>
            </div>

            {selectedRequest.vaccination_card && (
              <div className="request-notes-card vaccination-card-section">
                <h4><FaEye /> Vaccination Card</h4>
                <div className="vaccination-actions">
                  <button
                    type="button"
                    className="vaccination-view-btn"
                    onClick={() => openVaccinationCard(selectedRequest.vaccination_card_url)}
                  >
                    <FaEye /> View Vaccination Card
                  </button>
                  {selectedRequest.vaccination_card_verified_at ? (
                    <span className="vaccination-status verified">
                      <FaCheckCircle /> Verified
                    </span>
                  ) : (
                    <span className="vaccination-status unverified">
                      <FaTimesCircle /> Not Verified
                    </span>
                  )}
                </div>
              </div>
            )}

            <div className="hbk-foot">
              <button
                type="button"
                className="modal-secondary-action"
                onClick={() => setSelectedRequest(null)}
              >
                Close
              </button>

              <button
                type="button"
                className="approve-action"
                onClick={() => updateStatus(selectedRequest, "approved")}
                disabled={selectedRequest.status === "approved" || Boolean(busyAction)}
              >
                <FaCheckCircle />
                Approve
              </button>

              <button
                type="button"
                className="reject-action"
                onClick={() => updateStatus(selectedRequest, "rejected")}
                disabled={selectedRequest.status === "rejected" || Boolean(busyAction)}
              >
                <FaTimesCircle />
                Reject
              </button>

              <button
                type="button"
                className="reset-action"
                onClick={() => updateStatus(selectedRequest, "pending")}
                disabled={selectedRequest.status === "pending" || Boolean(busyAction)}
              >
                <FaUndoAlt />
                Reset
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ReceptionistDashboard;