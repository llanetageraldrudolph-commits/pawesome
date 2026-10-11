import React, { useCallback, useEffect, useMemo, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faCalendarAlt,
  faCheckCircle,
  faClipboardList,
  faClock,
  faDoorOpen,
  faDownload,
  faEye,
  faHotel,
  faInfoCircle,
  faPaw,
  faRefresh,
  faSearch,
  faSpinner,
  faTimes,
  faTimesCircle,
  faUser,
} from "@fortawesome/free-solid-svg-icons";
import "../../styles/bookingModal.css";
import "./ReceptionistHotelBookings.css";
import { apiRequest, getAuthenticatedFileUrl } from "../../api/client";
import { exportToCSV, exportToPDF, exportToExcel } from "../../utils/reportExport";
import { showError, showReasonPrompt, BOOKING_REJECT_REASONS } from "../../utils/alert.jsx";
import DatePickerInput from "../../components/shared/DatePickerInput";
import { formatDateOnly, parseDateOnly } from "../../utils/date";
import PetAvatar from "../shared/PetAvatar";
import RowActionPopover from "../shared/RowActionPopover";
import ServiceBillingPanel from "../shared/ServiceBillingPanel";
import {
  normalizeList,
  normalizeStatus,
  normalizePaymentStatus,
  formatStatus,
  formatDate,
  formatDateTime,
  formatCurrency,
  getDateValue,
  getDateTimeTimestamp,
  getPetName,
  getCustomerName,
  getCustomerPhone,
  getRoomName,
} from "../../utils/apiNormalize";

const STATUS_OPTIONS = [
  { value: "all", label: "All Status" },
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "scheduled", label: "Scheduled" },
  { value: "checked_in", label: "Checked In" },
  { value: "in_care", label: "In Care" },
  { value: "ready_for_pickup", label: "Ready for Pickup" },
  { value: "completed", label: "Completed" },
  { value: "rejected", label: "Rejected" },
  { value: "cancelled", label: "Cancelled" },
];

const PAYMENT_OPTIONS = [
  { value: "all", label: "All Payments" },
  { value: "unpaid", label: "Unpaid" },
  { value: "pending", label: "Pending" },
  { value: "paid", label: "Paid" },
  { value: "partial", label: "Partial" },
  { value: "rejected", label: "Rejected" },
];

const CARE_LOG_TYPES = [
  { value: "feeding", label: "Feeding" },
  { value: "water", label: "Water" },
  { value: "walk", label: "Walk" },
  { value: "playtime", label: "Playtime" },
  { value: "medication", label: "Medication" },
  { value: "cleaning", label: "Cleaning" },
  { value: "behavior", label: "Behavior" },
  { value: "health_observation", label: "Health Observation" },
  { value: "general_update", label: "General Update" },
];

const getRoomOptionName = (room) =>
  room.name || room.room_number || room.room_name || `Room #${room.id}`;

const formatTime12 = (value) => {
  if (!value) return "";
  const [h = 0, m = 0] = String(value).split(":");
  const hour = Number(h);
  const meridiem = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${String(m).padStart(2, "0")} ${meridiem}`;
};

const ReceptionistHotelBookings = () => {
  const [searchTerm, setSearchTerm] = useState("");
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterPayment, setFilterPayment] = useState("all");

  const [selectedBooking, setSelectedBooking] = useState(null);
  const [bookings, setBookings] = useState([]);
  const [rooms, setRooms] = useState([]);

  const [processingId, setProcessingId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [error, setError] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [lastUpdated, setLastUpdated] = useState("");

  const [showExportDropdown, setShowExportDropdown] = useState(false);

  const [scheduleDraft, setScheduleDraft] = useState({});
  const [careDraft, setCareDraft] = useState({
    log_type: "general_update",
    notes: "",
  });

  const showMessage = (type, message) => {
    if (type === "success") {
      setSuccessMessage(message);
      window.clearTimeout(window.hotelSuccessTimer);
      window.hotelSuccessTimer = window.setTimeout(() => setSuccessMessage(""), 3000);
      return;
    }

    setError(message);
    window.clearTimeout(window.hotelErrorTimer);
    window.hotelErrorTimer = window.setTimeout(() => setError(""), 5000);
  };

  const fetchBookings = useCallback(async ({ silent = false } = {}) => {
    try {
      if (silent) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }

      setError("");

      const data = await apiRequest("/receptionist/boarding-requests");
      const list = normalizeList(data, ["boarding_requests", "boardings", "requests"]);

      setBookings(
        list.map((item) => ({
          ...item,
          status: normalizeStatus(item.status),
          payment_status: normalizePaymentStatus(item.payment_status),
        }))
      );

      setLastUpdated(new Date().toLocaleString("en-PH"));
    } catch (err) {
      showMessage("error", err.message || "Failed to load boarding requests.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const fetchRooms = useCallback(async () => {
    try {
      const data = await apiRequest("/receptionist/boarding-rooms");
      setRooms(normalizeList(data, ["rooms", "hotel_rooms", "available_rooms"]));
    } catch (err) {
      setRooms([]);
    }
  }, []);

  const handleBillingRefresh = useCallback(
    () => fetchBookings({ silent: true }),
    [fetchBookings]
  );

  useEffect(() => {
    fetchBookings();
    fetchRooms();

    const intervalId = setInterval(() => {
      fetchBookings({ silent: true });
      fetchRooms();
    }, 30000);

    return () => clearInterval(intervalId);
  }, [fetchBookings, fetchRooms]);

  const stats = useMemo(
    () => ({
      total: bookings.length,
      pending: bookings.filter((item) => normalizeStatus(item.status) === "pending").length,
      scheduled: bookings.filter((item) =>
        ["approved", "scheduled"].includes(normalizeStatus(item.status))
      ).length,
      active: bookings.filter((item) =>
        ["checked_in", "in_care"].includes(normalizeStatus(item.status))
      ).length,
      ready: bookings.filter((item) => normalizeStatus(item.status) === "ready_for_pickup")
        .length,
      completed: bookings.filter((item) => normalizeStatus(item.status) === "completed")
        .length,
    }),
    [bookings]
  );

  const filteredBookings = useMemo(() => {
    const keyword = searchTerm.trim().toLowerCase();

    return bookings.filter((booking) => {
      const status = normalizeStatus(booking.status);
      const paymentStatus = normalizePaymentStatus(booking.payment_status);

      const haystack = [
        booking.id,
        getPetName(booking),
        getCustomerName(booking),
        getCustomerPhone(booking),
        booking.customer_email,
        getRoomName(booking),
        booking.special_requests,
        booking.feeding_instructions,
        booking.notes,
        status,
        paymentStatus,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      const matchesSearch = !keyword || haystack.includes(keyword);
      const matchesStatus = filterStatus === "all" || status === filterStatus;
      const matchesPayment = filterPayment === "all" || paymentStatus === filterPayment;

      return matchesSearch && matchesStatus && matchesPayment;
    }).sort((a, b) =>
      getDateTimeTimestamp(
        a.check_in || a.check_in_date || a.booking_date || a.start_date || a.date,
        a.check_in_time || a.booking_time || a.time
      ) - getDateTimeTimestamp(
        b.check_in || b.check_in_date || b.booking_date || b.start_date || b.date,
        b.check_in_time || b.booking_time || b.time
      )
    );
  }, [bookings, searchTerm, filterStatus, filterPayment]);

  const rejectBooking = async (booking) => {
    const reason = await showReasonPrompt(
      `Reject booking ${booking.id ? `#${booking.id}` : ""} for ${booking.pet?.name || booking.pet_name || "this pet"}? Please select a reason.`,
      "Reject Booking",
      "Reject",
      BOOKING_REJECT_REASONS
    );
    if (!reason) return;
    await runAction(
      booking,
      `/receptionist/boarding-requests/${booking.id}/reject`,
      "Boarding rejected.",
      { rejection_reason: reason }
    );
  };

  const runAction = async (booking, endpoint, message, body = null, method = "POST") => {
    try {
      setProcessingId(booking.id);
      setError("");

      await apiRequest(endpoint, {
        method,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });

      showMessage("success", message);
      await fetchBookings({ silent: true });
      await fetchRooms();
    } catch (err) {
      // Handle specific double booking conflict errors
      if (err.message?.includes('already booked for selected date range')) {
        showMessage("error", "This room/kennel is already booked for the selected date range.");
      } else {
        showMessage("error", err.message || "Action failed.");
      }
    } finally {
      setProcessingId(null);
    }
  };

  const verifyVaccination = async (booking) => {
    try {
      setProcessingId(booking.id);
      setError("");
      await apiRequest(`/receptionist/boarding-requests/${booking.id}/verify-vaccination`, {
        method: "POST",
      });
      const verifiedAt = new Date().toISOString();
      setSelectedBooking((prev) =>
        prev ? { ...prev, vaccination_card_verified_at: verifiedAt } : prev
      );
      setBookings((prev) =>
        prev.map((b) =>
          b.id === booking.id ? { ...b, vaccination_card_verified_at: verifiedAt } : b
        )
      );
      showMessage("success", "Vaccination card verified.");
    } catch (err) {
      showMessage("error", err.message || "Failed to verify vaccination card.");
    } finally {
      setProcessingId(null);
    }
  };

  const updateScheduleDraft = (bookingId, field, value) => {
    setScheduleDraft((prev) => ({
      ...prev,
      [bookingId]: {
        ...(prev[bookingId] || {}),
        [field]: value,
      },
    }));
  };

  const scheduleBooking = async (booking) => {
    const draft = scheduleDraft[booking.id] || {};

    if (!draft.hotel_room_id) {
      showMessage("error", "Select a room before scheduling.");
      return;
    }

    await runAction(
      booking,
      `/receptionist/boarding-requests/${booking.id}/schedule`,
      "Boarding scheduled successfully.",
      {
        hotel_room_id: draft.hotel_room_id,
        check_in: draft.check_in || getDateValue(booking.check_in),
        check_out: draft.check_in || getDateValue(booking.check_in),
        check_in_time: draft.check_in_time || booking.check_in_time || "10:00",
        check_out_time: draft.check_out_time || booking.check_out_time || "18:00",
        total_amount: draft.total_amount || booking.total_amount || booking.amount || 0,
      }
    );
  };

  const addCareLog = async (booking) => {
    if (!careDraft.notes.trim()) {
      showMessage("error", "Care log notes are required.");
      return;
    }

    await runAction(
      booking,
      `/receptionist/boarding-requests/${booking.id}/care-logs`,
      "Care log added successfully.",
      careDraft
    );

    setCareDraft({ log_type: "general_update", notes: "" });
  };

  const clearFilters = () => {
    setSearchTerm("");
    setFilterStatus("all");
    setFilterPayment("all");
  };

  const exportColumns = [
    { key: "id", label: "ID" },
    { key: "pet", label: "Pet" },
    { key: "customer", label: "Customer" },
    { key: "phone", label: "Phone" },
    { key: "checkIn", label: "Check In" },
    { key: "checkOut", label: "Check Out" },
    { key: "room", label: "Room" },
    { key: "payment", label: "Payment" },
    { key: "status", label: "Status" },
    { key: "amount", label: "Amount" },
  ];

  const handleExport = (format) => {
    setShowExportDropdown(false);
    if (filteredBookings.length === 0) {
      showMessage("error", "No hotel boarding records to export.");
      return;
    }

    const exportData = filteredBookings.map((booking) => ({
      id: booking.id,
      pet: getPetName(booking),
      customer: getCustomerName(booking),
      phone: getCustomerPhone(booking),
      checkIn: getDateValue(booking.check_in),
      checkOut: getDateValue(booking.check_out),
      room: getRoomName(booking),
      payment: normalizePaymentStatus(booking.payment_status),
      status: normalizeStatus(booking.status),
      amount: booking.total_amount || booking.amount || 0,
    }));

    const filename = "hotel-boarding";
    if (format === "csv") exportToCSV(exportData, exportColumns, filename);
    else if (format === "excel") exportToExcel(exportData, exportColumns, filename);
    else if (format === "pdf") exportToPDF(exportData, exportColumns, "Hotel Boarding Records", filename);

    showMessage("success", "Hotel boarding records exported.");
  };

  const getStatusClass = (status) => {
    const value = normalizeStatus(status);

    if (["approved", "scheduled", "completed"].includes(value)) return "success";
    if (["pending", "checked_in", "in_care", "ready_for_pickup"].includes(value)) {
      return "warning";
    }
    if (["rejected", "cancelled"].includes(value)) return "danger";

    return "secondary";
  };

  const getStatusIcon = (status) => {
    const value = normalizeStatus(status);

    if (["approved", "scheduled", "completed"].includes(value)) return faCheckCircle;
    if (["rejected", "cancelled"].includes(value)) return faTimesCircle;

    return faClock;
  };

  const getPaymentClass = (status) => {
    const value = normalizePaymentStatus(status);

    if (value === "paid") return "paid";
    if (value === "partial") return "partial";
    if (value === "pending") return "pending";
    if (value === "rejected") return "rejected";

    return "unpaid";
  };

  const isProcessing = (booking) => processingId === booking.id;

  return (
    <div className="hotel-bookings">
      {error && (
        <div className="hotel-toast error">
          <FontAwesomeIcon icon={faTimesCircle} />
          <span>{error}</span>
        </div>
      )}

      {successMessage && (
        <div className="hotel-toast success">
          <FontAwesomeIcon icon={faCheckCircle} />
          <span>{successMessage}</span>
        </div>
      )}

      <section className="hotel-hero">
        <div>
          <span className="hotel-eyebrow">
            <FontAwesomeIcon icon={faHotel} />
            Receptionist Hotel Operations
          </span>

          <h1>Hotel Boarding Management</h1>

          <p>
            Approve boarding requests, assign rooms, check pets in, add care logs,
            prepare pickup, and complete hotel stay workflows.
          </p>

          <small>Last updated: {lastUpdated || "Not refreshed yet"}</small>
        </div>

        <div className="hotel-hero-actions">

          <button
            type="button"
            className={`secondary-btn ${refreshing ? "loading" : ""}`}
            onClick={() => {
              fetchBookings({ silent: true });
              fetchRooms();
            }}
            disabled={refreshing}
          >
            <FontAwesomeIcon icon={refreshing ? faSpinner : faRefresh} />
            {refreshing ? "Refreshing..." : "Refresh"}
          </button>

          <div className="export-dropdown-wrapper" style={{ position: "relative" }}>
            <button type="button" className="secondary-btn" onClick={() => setShowExportDropdown(!showExportDropdown)}>
              <FontAwesomeIcon icon={faDownload} />
              Export ▼
            </button>
            {showExportDropdown && (
              <>
                <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, zIndex: 998 }} onClick={() => setShowExportDropdown(false)} />
                <div style={{ position: "absolute", top: "100%", right: 0, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,0.12)", zIndex: 999, minWidth: 160, overflow: "hidden" }}>
                  <button type="button" className="secondary-btn" style={{ width: "100%", justifyContent: "flex-start" }} onClick={() => handleExport("csv")}>Export as CSV</button>
                  <button type="button" className="secondary-btn" style={{ width: "100%", justifyContent: "flex-start" }} onClick={() => handleExport("excel")}>Export as Excel</button>
                  <button type="button" className="secondary-btn" style={{ width: "100%", justifyContent: "flex-start" }} onClick={() => handleExport("pdf")}>Export as PDF</button>
                </div>
              </>
            )}
          </div>
        </div>
      </section>

      <section className="hotel-summary-grid">
        <button type="button" className="hotel-summary-card" onClick={() => setFilterStatus("all")}>
          <span>
            <FontAwesomeIcon icon={faHotel} />
          </span>
          <div>
            <strong>{stats.total}</strong>
            <p>Total Requests</p>
          </div>
        </button>

        <button type="button" className="hotel-summary-card warning" onClick={() => setFilterStatus("pending")}>
          <span>
            <FontAwesomeIcon icon={faClock} />
          </span>
          <div>
            <strong>{stats.pending}</strong>
            <p>Pending</p>
          </div>
        </button>

        <button type="button" className="hotel-summary-card info" onClick={() => setFilterStatus("scheduled")}>
          <span>
            <FontAwesomeIcon icon={faCalendarAlt} />
          </span>
          <div>
            <strong>{stats.scheduled}</strong>
            <p>Approved / Scheduled</p>
          </div>
        </button>

        <button type="button" className="hotel-summary-card active" onClick={() => setFilterStatus("in_care")}>
          <span>
            <FontAwesomeIcon icon={faDoorOpen} />
          </span>
          <div>
            <strong>{stats.active}</strong>
            <p>In Care</p>
          </div>
        </button>

        <button type="button" className="hotel-summary-card success" onClick={() => setFilterStatus("completed")}>
          <span>
            <FontAwesomeIcon icon={faCheckCircle} />
          </span>
          <div>
            <strong>{stats.completed}</strong>
            <p>Completed</p>
          </div>
        </button>
      </section>

      <section className="hotel-controls">
        <div className="hotel-search-box">
          <input
            type="text"
            placeholder="Search pet, customer, room, phone, notes..."
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
          />

          {searchTerm && (
            <button type="button" onClick={() => setSearchTerm("")}>
              <FontAwesomeIcon icon={faTimes} />
            </button>
          )}
        </div>

        <label className="hotel-filter-box">
          <select
            value={filterStatus}
            onChange={(event) => setFilterStatus(event.target.value)}
          >
            {STATUS_OPTIONS.map((option) => (
              <option value={option.value} key={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="hotel-filter-box">
          <select
            value={filterPayment}
            onChange={(event) => setFilterPayment(event.target.value)}
          >
            {PAYMENT_OPTIONS.map((option) => (
              <option value={option.value} key={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <button type="button" className="clear-btn" onClick={clearFilters}>
          <FontAwesomeIcon icon={faTimes} />
          Clear
        </button>
      </section>

      <section className="hotel-table-card">
        <div className="hotel-table-header">
          <div>
            <span className="hotel-eyebrow">
              <FontAwesomeIcon icon={faClipboardList} />
              Live Boarding Queue
            </span>
            <h2>Hotel Boarding Requests</h2>
            <p>
              Showing <strong>{filteredBookings.length}</strong> of{" "}
              <strong>{bookings.length}</strong> record(s).
            </p>
          </div>
        </div>

        {loading ? (
          <div className="hotel-state">
            <FontAwesomeIcon icon={faSpinner} spin />
            <h3>Loading hotel boarding requests...</h3>
            <p>Please wait while the system loads live boarding data.</p>
          </div>
        ) : (
          <div className="hotel-table-scroll">
            <table className="bookings-table">
              <thead>
                <tr>
                  <th>Pet</th>
                  <th>Customer</th>
                  <th>Stay</th>
                  <th>Room</th>
                  <th>Payment</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>

              <tbody>
                {filteredBookings.length === 0 && (
                  <tr>
                    <td colSpan="7">
                      <div className="hotel-empty-state">
                        <FontAwesomeIcon icon={faSearch} />
                        <h3>No hotel boarding records found</h3>
                        <p>Try adjusting the search keyword, status, or payment filter.</p>
                      </div>
                    </td>
                  </tr>
                )}

                {filteredBookings.map((booking) => {
                  const status = normalizeStatus(booking.status);
                  const paymentStatus = normalizePaymentStatus(booking.payment_status);

                  return (
                    <tr key={booking.id} className="booking-row">
                      <td>
                        <div className="pet-cell">
                          <PetAvatar pet={booking.pet} size={36} />
                          <span>{getPetName(booking)}</span>
                        </div>
                      </td>

                      <td>
                        <div className="customer-cell">
                          <FontAwesomeIcon icon={faUser} />
                          <span>{getCustomerName(booking)}</span>
                        </div>
                      </td>

                      <td>
                        <div className="stay-cell">
                          <FontAwesomeIcon icon={faCalendarAlt} />
                          <span>{formatDate(booking.check_in)} - {formatDate(booking.check_out)}</span>
                        </div>
                      </td>

                      <td>
                        <div className="room-cell">
                          <span>{getRoomName(booking)}</span>
                        </div>
                      </td>

                      <td>
                        <div className="payment-cell">
                          <span className={`payment-badge ${getPaymentClass(paymentStatus)}`}>
                            {formatStatus(paymentStatus)}
                          </span>
                        </div>
                      </td>

                      <td>
                        <div className="status-cell">
                          <span className={`status-badge ${getStatusClass(status)}`}>
                            {formatStatus(status)}
                          </span>
                        </div>
                      </td>

                      <td>
                        <RowActionPopover rowLabel={getPetName(booking)}>
                          <div className="actions-cell">
                          <button
                            type="button"
                            className="action-btn view-btn"
                            onClick={() => setSelectedBooking(booking)}
                            title="View / Manage"
                          >
                            <FontAwesomeIcon icon={faEye} />
                          </button>

                        {status === "pending" && (
                          <>
                            <button
                              type="button"
                              className="action-btn approve-btn"
                              onClick={() =>
                                runAction(
                                  booking,
                                  `/receptionist/boarding-requests/${booking.id}/approve`,
                                  "Boarding approved."
                                )
                              }
                              disabled={isProcessing(booking)}
                              title="Approve"
                            >
                              <FontAwesomeIcon
                                icon={isProcessing(booking) ? faSpinner : faCheckCircle}
                                spin={isProcessing(booking)}
                              />
                            </button>

                            <button
                              type="button"
                              className="action-btn reject-btn"
                              onClick={() => rejectBooking(booking)}
                              disabled={isProcessing(booking)}
                              title="Reject"
                            >
                              <FontAwesomeIcon icon={faTimesCircle} />
                            </button>
                          </>
                        )}

                        {["approved", "scheduled"].includes(status) && (
                          <button
                            type="button"
                            className="action-btn check-btn"
                            onClick={() =>
                              runAction(
                                booking,
                                `/receptionist/boarding-requests/${booking.id}/check-in`,
                                "Pet checked in."
                              )
                            }
                            disabled={isProcessing(booking)}
                            title="Check In"
                          >
                            <FontAwesomeIcon icon={faDoorOpen} />
                          </button>
                        )}

                        {["checked_in", "in_care"].includes(status) && (
                          <button
                            type="button"
                            className="action-btn approve-btn"
                            onClick={() =>
                              runAction(
                                booking,
                                `/receptionist/boarding-requests/${booking.id}/ready-for-pickup`,
                                "Pet marked ready for pickup."
                              )
                            }
                            disabled={isProcessing(booking)}
                            title="Ready for Pickup"
                          >
                            <FontAwesomeIcon icon={faCheckCircle} />
                          </button>
                        )}

                        {status === "ready_for_pickup" && (
                          <button
                            type="button"
                            className="action-btn check-btn"
                            onClick={() =>
                              runAction(
                                booking,
                                `/receptionist/boarding-requests/${booking.id}/check-out`,
                                "Pet checked out."
                              )
                            }
                            disabled={isProcessing(booking)}
                            title="Check Out"
                          >
                            <FontAwesomeIcon icon={faDoorOpen} />
                          </button>
                        )}
                          </div>
                        </RowActionPopover>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {selectedBooking && (() => {
        const bookingStatus = normalizeStatus(selectedBooking.status);
        const payStatus = normalizePaymentStatus(selectedBooking.payment_status);
        const stayDate = getDateValue(selectedBooking.check_in);
        const stayHours = `${formatTime12(selectedBooking.check_in_time || "10:00")} – ${formatTime12(selectedBooking.check_out_time || "18:00")}`;

        return (
          <div className="hbk-overlay" onClick={() => setSelectedBooking(null)}>
            <div className="hbk-modal" onClick={(event) => event.stopPropagation()}>
              <div className="hbk-head">
                <div className="hbk-head-left">
                  <span className="hotel-eyebrow">
                    <FontAwesomeIcon icon={faInfoCircle} />
                    Boarding Details
                  </span>
                  <div className="hbk-title-row">
                    <h2>Boarding #{selectedBooking.id}</h2>
                    <span className={`hbk-pill is-${bookingStatus}`}>
                      {formatStatus(bookingStatus)}
                    </span>
                  </div>
                </div>

                <button
                  type="button"
                  className="close-btn"
                  onClick={() => setSelectedBooking(null)}
                >
                  <FontAwesomeIcon icon={faTimes} />
                </button>
              </div>

              <div className="hbk-body">
                {/* Guest summary */}
                <div className="hbk-guest">
                  <div className="hbk-guest-avatar">
                    <PetAvatar pet={selectedBooking.pet} size={52} />
                  </div>
                  <div className="hbk-guest-meta">
                    <strong>{getPetName(selectedBooking)}</strong>
                    <span>
                      <FontAwesomeIcon icon={faUser} />
                      {getCustomerName(selectedBooking)}
                    </span>
                    <span className="hbk-guest-phone">
                      {getCustomerPhone(selectedBooking) || "No phone on file"}
                    </span>
                  </div>
                  <div className="hbk-guest-billing">
                    <label>Total Amount</label>
                    <strong>
                      {formatCurrency(
                        selectedBooking.total_amount || selectedBooking.amount || 0
                      )}
                    </strong>
                    <span className={`hbk-pay is-${payStatus}`}>
                      {formatStatus(payStatus)}
                    </span>
                  </div>
                </div>

                {/* Stay details */}
                <div className="hbk-grid">
                  <div className="hbk-cell">
                    <label>
                      <FontAwesomeIcon icon={faDoorOpen} /> Room / Kennel
                    </label>
                    <span>{getRoomName(selectedBooking)}</span>
                  </div>
                  <div className="hbk-cell">
                    <label>
                      <FontAwesomeIcon icon={faCalendarAlt} /> Stay Date
                    </label>
                    <span>{formatDate(stayDate)}</span>
                  </div>
                  <div className="hbk-cell">
                    <label>
                      <FontAwesomeIcon icon={faClock} /> Visit Hours
                    </label>
                    <span>{stayHours}</span>
                  </div>
                  <div className="hbk-cell full">
                    <label>
                      <FontAwesomeIcon icon={faClipboardList} /> Instructions
                    </label>
                    <span>{selectedBooking.notes || "None"}</span>
                  </div>
                </div>

                {/* Vaccination card */}
                {selectedBooking.vaccination_card && (
                  <div className="hbk-vax">
                    <div className="hbk-vax-info">
                      <FontAwesomeIcon icon={faCheckCircle} className="hbk-vax-icon" />
                      <div>
                        <strong>Vaccination Card</strong>
                        <span>
                          {selectedBooking.vaccination_card_verified_at
                            ? `Verified ${formatDateTime(selectedBooking.vaccination_card_verified_at)}`
                            : "Uploaded — pending verification"}
                        </span>
                      </div>
                    </div>
                    <div className="vaccination-actions">
                      <button
                        type="button"
                        className="vaccination-link"
                        onClick={async () => {
                          const win = window.open("", "_blank");
                          if (!win) {
                            showError("Popup blocked. Please allow popups for this site.");
                            return;
                          }
                          try {
                            const url = await getAuthenticatedFileUrl(
                              selectedBooking.vaccination_card_url || `/files/vaccination-cards/${selectedBooking.id}/view`
                            );
                            win.location.href = url;
                          } catch (err) {
                            win.close();
                            console.error("Vaccination card open error:", err);
                            showError(err.message || "Failed to open vaccination card.");
                          }
                        }}
                      >
                        <FontAwesomeIcon icon={faEye} /> View Card
                      </button>
                      {!selectedBooking.vaccination_card_verified_at && (
                        <button
                          type="button"
                          className="vaccination-verify-btn"
                          onClick={() => verifyVaccination(selectedBooking)}
                          disabled={processingId === selectedBooking.id}
                        >
                          <FontAwesomeIcon icon={faCheckCircle} />
                          {processingId === selectedBooking.id ? " Verifying..." : " Verify"}
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {["pending", "approved"].includes(bookingStatus) && (
                  <div className="hbk-panel">
                    <div className="hbk-panel-head">
                      <h3>Schedule / Assign Room</h3>
                      <p>Select an available room and finalize the stay details.</p>
                    </div>

                    <div className="form-row">
                      <div className="form-group">
                        <label>Room / Kennel</label>
                        <select
                          value={scheduleDraft[selectedBooking.id]?.hotel_room_id || ""}
                          onChange={(event) =>
                            updateScheduleDraft(
                              selectedBooking.id,
                              "hotel_room_id",
                              event.target.value
                            )
                          }
                        >
                          <option value="">Select room</option>
                          {rooms.map((room) => (
                            <option key={room.id} value={room.id}>
                              {getRoomOptionName(room)} ({room.status || "available"})
                            </option>
                          ))}
                        </select>
                      </div>

                      <div className="form-group">
                        <label>Total Amount</label>
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={scheduleDraft[selectedBooking.id]?.total_amount || ""}
                          onChange={(event) =>
                            updateScheduleDraft(
                              selectedBooking.id,
                              "total_amount",
                              event.target.value
                            )
                          }
                          placeholder="0.00"
                        />
                      </div>
                    </div>

                    <div className="form-row">
                      <div className="form-group">
                        <label>Stay Date (same-day check-in/check-out)</label>
                        <DatePickerInput
                          withPortal
                          selected={(() => {
                            const val = scheduleDraft[selectedBooking.id]?.check_in || stayDate;
                            return parseDateOnly(val);
                          })()}
                          onChange={(date) =>
                            updateScheduleDraft(selectedBooking.id, "check_in", formatDateOnly(date))
                          }
                          placeholderText="mm/dd/yyyy"
                        />
                      </div>

                      <div className="form-group">
                        <label>Check In Time</label>
                        <input
                          type="time"
                          min="10:00"
                          max="18:00"
                          value={scheduleDraft[selectedBooking.id]?.check_in_time || selectedBooking.check_in_time || "10:00"}
                          onChange={(event) =>
                            updateScheduleDraft(selectedBooking.id, "check_in_time", event.target.value)
                          }
                        />
                      </div>
                    </div>

                    <div className="form-row">
                      <div className="form-group">
                        <label>Check Out Time</label>
                        <input
                          type="time"
                          min="10:00"
                          max="18:00"
                          value={scheduleDraft[selectedBooking.id]?.check_out_time || selectedBooking.check_out_time || "18:00"}
                          onChange={(event) =>
                            updateScheduleDraft(selectedBooking.id, "check_out_time", event.target.value)
                          }
                        />
                        <small className="hbk-hint">
                          Store hours 10:00 AM – 6:00 PM · same-day checkout
                        </small>
                      </div>
                    </div>

                    <div className="form-actions">
                      <button
                        type="button"
                        className="submit-btn"
                        onClick={() => scheduleBooking(selectedBooking)}
                        disabled={isProcessing(selectedBooking)}
                      >
                        {isProcessing(selectedBooking) && (
                          <FontAwesomeIcon icon={faSpinner} spin />
                        )}
                        Schedule Boarding
                      </button>
                    </div>
                  </div>
                )}

                {["checked_in", "in_care"].includes(bookingStatus) && (
                  <div className="hbk-panel">
                    <div className="hbk-panel-head">
                      <h3>Add Care Log</h3>
                      <p>Record feeding, cleaning, walking, medication, or care updates.</p>
                    </div>

                    <div className="form-row">
                      <div className="form-group">
                        <label>Care Log Type</label>
                        <select
                          value={careDraft.log_type}
                          onChange={(event) =>
                            setCareDraft((prev) => ({
                              ...prev,
                              log_type: event.target.value,
                            }))
                          }
                        >
                          {CARE_LOG_TYPES.map((type) => (
                            <option key={type.value} value={type.value}>
                              {type.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div className="form-row">
                      <div className="form-group full-width">
                        <label>Notes</label>
                        <textarea
                          rows="4"
                          value={careDraft.notes}
                          onChange={(event) =>
                            setCareDraft((prev) => ({
                              ...prev,
                              notes: event.target.value,
                            }))
                          }
                          placeholder="Write care notes here..."
                        />
                      </div>
                    </div>

                    <div className="form-actions">
                      <button
                        type="button"
                        className="submit-btn"
                        onClick={() => addCareLog(selectedBooking)}
                        disabled={isProcessing(selectedBooking)}
                      >
                        {isProcessing(selectedBooking) && (
                          <FontAwesomeIcon icon={faSpinner} spin />
                        )}
                        Add Care Log
                      </button>
                    </div>
                  </div>
                )}

                {!["pending", "rejected", "cancelled", "completed"].includes(bookingStatus) && (
                  <div className="hbk-panel">
                    <div className="hbk-panel-head">
                      <h3>Service Billing</h3>
                      <p>Additional charges and discounts for this stay. Final settlement is handled by the cashier.</p>
                    </div>
                    <ServiceBillingPanel
                      serviceType="boarding"
                      serviceId={selectedBooking.id}
                      petId={selectedBooking.pet_id}
                      onBillingUpdate={handleBillingRefresh}
                    />
                  </div>
                )}
              </div>

              <div className="hbk-foot">
                <button
                  type="button"
                  className="secondary-btn"
                  onClick={() => setSelectedBooking(null)}
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
};

export default ReceptionistHotelBookings;