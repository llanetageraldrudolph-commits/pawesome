import React, { useState, useEffect } from "react";
import { showConfirm, showError, showWarning, showReasonPrompt, STAFF_CANCEL_REASONS } from "../../utils/alert.jsx";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faStethoscope,
  faCalendarAlt,
  faSearch,
  faPlus,
  faCheckCircle,
  faTimesCircle,
  faClock,
  faPaw,
  faUserMd,
  faUser,
  faPhone,
  faSpinner,
  faExclamationTriangle,
  faCheck,
  faTasks,
  faTimes,
} from "@fortawesome/free-solid-svg-icons";
import { apiRequest } from "../../api/client";
import { getDateTimeTimestamp } from "../../utils/apiNormalize";
import PetAvatar from "../shared/PetAvatar";
import RowActionPopover from "../shared/RowActionPopover";
import "../../styles/bookingModal.css";
import "./ReceptionistVeterinaryBookings.css";

const ReceptionistVeterinaryBookings = () => {
  const [searchTerm, setSearchTerm] = useState("");
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterDoctor, setFilterDoctor] = useState("all");
  const [selectedAppointment, setSelectedAppointment] = useState(null);
  const [appointments, setAppointments] = useState([]);
  const [veterinarians, setVeterinarians] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [actionLoading, setActionLoading] = useState(false);
  const [selectedVet, setSelectedVet] = useState("");
  const [vetAssignments, setVetAssignments] = useState({});
  const [selectedIds, setSelectedIds] = useState(new Set());

  // Fetch appointments and veterinarians on mount
  useEffect(() => {
    fetchAppointments();
    fetchVeterinarians();
  }, []);

  const isVetRequest = (item) => {
    const values = [
      item.type,
      item.request_type,
      item.service_type,
      item.category,
      item.source,
      item.service_name,
      item.service,
      item.name,
    ]
      .filter(Boolean)
      .map((value) => String(value).toLowerCase());

    return values.some(
      (value) =>
        value === "vet" ||
        value === "veterinary" ||
        value.includes("veterinary") ||
        value.includes("consult") ||
        value.includes("vaccination") ||
        value.includes("medical")
    );
  };

  const fetchAppointments = async () => {
    try {
      setLoading(true);
      const data = await apiRequest("/receptionist/requests");
      
      // Filter only vet requests using robust type detection
      const requestData = Array.isArray(data) ? data : (data.requests || []);
      const vetOnly = requestData.filter(isVetRequest);
      
      const transformedAppointments = vetOnly.map(item => ({
        id: `APT-${String(item.id).padStart(3, '0')}`,
        rawId: item.id,
        appointmentId: item.appointment_id || item.appointment?.id || null,
        petName: item.pet,
        petType: "Pet",
        breed: "Unknown",
        owner: item.customer,
        ownerPhone: "N/A",
        doctor: "Unassigned",
        appointmentDate: item.appointment_date || item.scheduled_at || item.date || item.booking_date || "",
        appointmentTime: item.appointment_time || item.scheduled_time || item.time || "",
        duration: "30 mins",
        service: item.service,
        status: item.status,
        notes: item.notes || "",
        urgency: "medium",
      }));
      
      setAppointments(transformedAppointments);
      setError("");
    } catch (err) {
      setError("Failed to load appointments. Please try again.");
      showError("Failed to load appointments. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const fetchVeterinarians = async () => {
    try {
      const response = await apiRequest("/receptionist/veterinarians/available");
      const vets = response.veterinarians || response.data || response;
      const vetList = Array.isArray(vets) ? vets : [];

      setVeterinarians(vetList);

      if (vetList.length === 0) {
        setError("No active veterinarian accounts found. Create or activate a veterinarian user first.");
        showWarning("No active veterinarian accounts found. Create or activate a veterinarian user first.");
      }
    } catch (err) {
      setError("Could not load veterinarian list. Please refresh or check the receptionist permission.");
      showError("Could not load veterinarian list. Please refresh or check the receptionist permission.");
      setVeterinarians([]);
    }
  };

  // Approve appointment
  const handleApprove = async (appointmentId) => {
    const veterinarianId = vetAssignments[appointmentId] || selectedVet;

    if (!veterinarianId) {
      setError("Please choose a veterinarian before approving this appointment.");
      showWarning("Please choose a veterinarian before approving this appointment.");
      return;
    }

    try {
      setActionLoading(true);
      await apiRequest(`/receptionist/requests/${appointmentId}/approve`, {
        method: "POST",
        body: JSON.stringify({ veterinarian_id: Number(veterinarianId) }),
      });
      
      await fetchAppointments();
      setSelectedAppointment(null);
      setSelectedVet("");
      setError("");
    } catch (err) {
      setError(err.message || "Failed to approve appointment");
      showError(err.message || "Failed to approve appointment");
    } finally {
      setActionLoading(false);
    }
  };

  // Cancel/Reject appointment
  const handleCancel = async (appointmentId) => {
    const reason = await showReasonPrompt(
      "Cancel this appointment? Please select a reason.",
      "Cancel Appointment",
      "Cancel Appointment",
      STAFF_CANCEL_REASONS
    );
    if (!reason) return;

    try {
      setActionLoading(true);
      await apiRequest(`/receptionist/requests/${appointmentId}/reject`, {
        method: "POST",
        body: JSON.stringify({ rejection_reason: reason }),
      });
      
      await fetchAppointments();
      setSelectedAppointment(null);
      setError("");
    } catch (err) {
      setError(err.message || "Failed to cancel appointment");
      showError(err.message || "Failed to cancel appointment");
    } finally {
      setActionLoading(false);
    }
  };

  // Bulk actions
  const toggleSelect = (rawId) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(rawId)) next.delete(rawId); else next.add(rawId);
      return next;
    });
  };

  const selectAllVisible = () => {
    const visiblePending = filteredAppointments.filter((a) => a.status === "pending");
    if (visiblePending.length === 0) return;
    const allSelected = visiblePending.every((a) => selectedIds.has(a.rawId));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      visiblePending.forEach((a) => {
        if (allSelected) next.delete(a.rawId); else next.add(a.rawId);
      });
      return next;
    });
  };

  const handleBulkApprove = async () => {
    const ids = Array.from(selectedIds);
    const withoutVet = ids.filter((id) => !vetAssignments[id]);
    if (withoutVet.length > 0) { 
      setError("Please assign a veterinarian to every selected appointment."); 
      showWarning("Please assign a veterinarian to every selected appointment."); 
      return; 
    }
    if (!(await showConfirm(`Approve ${ids.length} selected appointments?`))) return;
    setActionLoading(true);
    setError("");
    try {
      await Promise.all(
        ids.map((id) =>
          apiRequest(`/receptionist/requests/${id}/approve`, {
            method: "POST",
            body: JSON.stringify({ veterinarian_id: Number(vetAssignments[id]) }),
          })
        )
      );
      setSelectedIds(new Set());
      await fetchAppointments();
    } catch (err) {
      setError(err.message || "Bulk approve failed.");
      showError(err.message || "Bulk approve failed.");
    } finally {
      setActionLoading(false);
    }
  };

  const handleBulkCancel = async () => {
    const ids = Array.from(selectedIds);
    const reason = await showReasonPrompt(
      `Cancel ${ids.length} selected appointment${ids.length > 1 ? "s" : ""}? Please select a reason.`,
      "Cancel Appointments",
      "Cancel Appointments",
      STAFF_CANCEL_REASONS
    );
    if (!reason) return;
    setActionLoading(true);
    setError("");
    try {
      await Promise.all(
        ids.map((id) =>
          apiRequest(`/receptionist/requests/${id}/status`, {
            method: "PATCH",
            body: JSON.stringify({ status: "rejected", rejection_reason: reason }),
          })
        )
      );
      setSelectedIds(new Set());
      await fetchAppointments();
    } catch (err) {
      setError(err.message || "Bulk cancel failed.");
      showError(err.message || "Bulk cancel failed.");
    } finally {
      setActionLoading(false);
    }
  };

  const vetAppointments = appointments;
  const doctors = ["all", ...veterinarians.map(v => v.name)];

  const filteredAppointments = vetAppointments.filter(appointment => {
    const matchesSearch = 
      (appointment.petName || "").toLowerCase().includes(searchTerm.toLowerCase()) ||
      (appointment.owner || "").toLowerCase().includes(searchTerm.toLowerCase()) ||
      (appointment.doctor || "").toLowerCase().includes(searchTerm.toLowerCase());
    
    const matchesStatus = filterStatus === "all" || appointment.status === filterStatus;
    const matchesDoctor = filterDoctor === "all" || appointment.doctor === filterDoctor;
    
    return matchesSearch && matchesStatus && matchesDoctor;
  }).sort((a, b) =>
    getDateTimeTimestamp(a.appointmentDate, a.appointmentTime) - getDateTimeTimestamp(b.appointmentDate, b.appointmentTime)
  );

  const getStatusColor = (status) => {
    switch (status) {
      case "approved":
        return "info";
      case "pending":
        return "warning";
      case "completed":
        return "success";
      case "cancelled":
      case "rejected":
        return "danger";
      default:
        return "secondary";
    }
  };

  const getStatusIcon = (status) => {
    switch (status) {
      case "approved":
        return faCheckCircle;
      case "pending":
        return faClock;
      case "completed":
        return faCheckCircle;
      case "cancelled":
      case "rejected":
        return faTimesCircle;
      default:
        return faClock;
    }
  };

  return (
    <div className="vet-bookings">
      <div className="vet-hero">
        <div>
          <h1>Veterinary Bookings</h1>
          <p>Manage veterinary appointments and schedule consultations</p>
        </div>
        <div className="vet-hero-actions">
          <button className="primary-btn" disabled>
            <FontAwesomeIcon icon={faPlus} />
            New Appointment
          </button>
        </div>
      </div>

      {error && (
        <div className="vet-error-banner">
          <FontAwesomeIcon icon={faExclamationTriangle} />
          <span>{error}</span>
        </div>
      )}

      {/* Summary Cards */}
      <div className="vet-summary-grid">
        <div className="vet-summary-card">
          <span>
            <FontAwesomeIcon icon={faCalendarAlt} />
          </span>
          <div>
            <strong>{vetAppointments.length}</strong>
            <p>Total Bookings</p>
          </div>
        </div>
        <div className="vet-summary-card">
          <span>
            <FontAwesomeIcon icon={faClock} />
          </span>
          <div>
            <strong>{vetAppointments.filter(a => a.status === 'pending').length}</strong>
            <p>Pending</p>
          </div>
        </div>
        <div className="vet-summary-card">
          <span>
            <FontAwesomeIcon icon={faCheckCircle} />
          </span>
          <div>
            <strong>{vetAppointments.filter(a => a.status === 'approved').length}</strong>
            <p>Approved</p>
          </div>
        </div>
        <div className="vet-summary-card">
          <span>
            <FontAwesomeIcon icon={faCheckCircle} />
          </span>
          <div>
            <strong>{vetAppointments.filter(a => a.status === 'completed').length}</strong>
            <p>Completed</p>
          </div>
        </div>
        <div className="vet-summary-card">
          <span>
            <FontAwesomeIcon icon={faTimesCircle} />
          </span>
          <div>
            <strong>{vetAppointments.filter(a => a.status === 'cancelled' || a.status === 'rejected').length}</strong>
            <p>Cancelled</p>
          </div>
        </div>
      </div>

      {/* Bulk Action Bar */}
      {selectedIds.size > 0 && (
        <div className="vet-bulk-action-bar">
          <span><FontAwesomeIcon icon={faTasks} /> <strong>{selectedIds.size}</strong> selected</span>
          <div className="vet-bulk-actions">
            <button className="primary-btn" onClick={handleBulkApprove} disabled={actionLoading}>
              <FontAwesomeIcon icon={faCheckCircle} /> Approve Selected
            </button>
            <button className="secondary-btn" onClick={handleBulkCancel} disabled={actionLoading}>
              <FontAwesomeIcon icon={faTimesCircle} /> Cancel Selected
            </button>
            <button className="secondary-btn" onClick={() => setSelectedIds(new Set())} disabled={actionLoading}>
              <FontAwesomeIcon icon={faTimes} /> Clear
            </button>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="vet-controls">
        <div className="vet-search-box">
          <input
            type="text"
            placeholder="Search by pet name, owner, or doctor..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>
        <div className="vet-filter-box">
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
          >
            <option value="all">All Status</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
            <option value="rejected">Rejected</option>
          </select>
        </div>
        <div className="vet-filter-box">
          <select
            value={filterDoctor}
            onChange={(e) => setFilterDoctor(e.target.value)}
          >
            <option value="all">All Doctors</option>
            {doctors.map(doctor => (
              <option key={doctor} value={doctor}>{doctor}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Appointments Table */}
      <div className="vet-table-card">
        <div className="vet-table-scroll">
        <table className="vet-table">
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  onChange={selectAllVisible}
                  checked={
                    filteredAppointments.filter((a) => a.status === "pending").length > 0 &&
                    filteredAppointments.filter((a) => a.status === "pending").every((a) => selectedIds.has(a.rawId))
                  }
                  title="Select all pending"
                />
              </th>
              <th>Booking ID</th>
              <th>Pet Info</th>
              <th>Owner</th>
              <th>Doctor</th>
              <th>Date & Time</th>
              <th>Service</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredAppointments.map((appointment) => (
              <tr key={appointment.id}>
                <td className="row-selection-spacer" />
                <td>
                  <span className="id-badge">{appointment.id}</span>
                </td>
                <td>
                  <div className="pet-cell">
                    <PetAvatar pet={appointment.pet} size={36} />
                    <span>{appointment.petName}</span>
                  </div>
                </td>
                <td>
                  <div className="customer-cell">
                    <FontAwesomeIcon icon={faUser} />
                    <span>{appointment.owner}</span>
                  </div>
                </td>
                <td>
                  <div className="doctor-cell">
                    <FontAwesomeIcon icon={faUserMd} />
                    <span>{appointment.doctor}</span>
                  </div>
                </td>
                <td>
                  <div className="date-cell">
                    <FontAwesomeIcon icon={faCalendarAlt} />
                    <span>{appointment.appointmentDate}</span>
                  </div>
                </td>
                <td>
                  <div className="service-cell">
                    <FontAwesomeIcon icon={faStethoscope} />
                    <span>{appointment.service}</span>
                  </div>
                </td>
                <td>
                  <div className="status-cell">
                    <span className={`status-badge ${getStatusColor(appointment.status)}`}>
                      {appointment.status}
                    </span>
                  </div>
                </td>
                <td>
                  <RowActionPopover rowLabel={appointment.petName}>
                    {appointment.status === "pending" && (
                      <label className="row-action-popover-checkbox">
                        <input
                          type="checkbox"
                          aria-label={`Select ${appointment.petName} for bulk actions`}
                          checked={selectedIds.has(appointment.rawId)}
                          onChange={() => toggleSelect(appointment.rawId)}
                        />
                        <span>Select for bulk actions</span>
                      </label>
                    )}
                    {appointment.status === "pending" ? (
                      <label className="row-action-popover-control">
                        <span>Assign veterinarian</span>
                        <select
                          aria-label={`Assign veterinarian to ${appointment.petName}`}
                          value={vetAssignments[appointment.rawId] || ""}
                          onChange={(event) =>
                            setVetAssignments((current) => ({
                              ...current,
                              [appointment.rawId]: event.target.value,
                            }))
                          }
                        >
                          <option value="">{veterinarians.length ? "Choose vet" : "No active vets"}</option>
                          {veterinarians.map((vet) => (
                            <option key={vet.id} value={vet.id}>{vet.name}</option>
                          ))}
                        </select>
                      </label>
                    ) : (
                      <div className="row-action-popover-control"><span>Assigned veterinarian: {appointment.doctor}</span></div>
                    )}
                    <div className="actions-cell">
                    {appointment.status === 'pending' && (
                    <button 
                      className="action-btn approve-btn" 
                      title="Approve"
                      onClick={() => handleApprove(appointment.rawId)}
                      disabled={actionLoading || veterinarians.length === 0}
                    >
                      <FontAwesomeIcon icon={faCheck} />
                    </button>
                  )}
                  <button 
                    className="action-btn view-btn"
                    onClick={() => setSelectedAppointment(appointment)}
                    title="View Details"
                  >
                    <FontAwesomeIcon icon={faSearch} />
                  </button>
                  {(appointment.status === 'pending' || appointment.status === 'approved') && (
                    <button 
                      className="action-btn delete-btn" 
                      title="Cancel"
                      onClick={() => handleCancel(appointment.rawId)}
                      disabled={actionLoading}
                    >
                      <FontAwesomeIcon icon={faTimesCircle} />
                    </button>
                  )}
                    </div>
                  </RowActionPopover>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        
        {filteredAppointments.length === 0 && !loading && (
          <div className="empty-state">
            <FontAwesomeIcon icon={faStethoscope} size="3x" />
            <h3>No veterinary bookings found</h3>
            <p>Try adjusting your search or filters</p>
          </div>
        )}
      </div></div>

      {/* Appointment Details Modal */}
      {selectedAppointment && (
        <div className="hbk-overlay" onClick={() => setSelectedAppointment(null)}>
          <div className="hbk-modal" onClick={(e) => e.stopPropagation()}>
            <div className="hbk-head">
              <h2>Booking Details</h2>
              <button
                className="close-btn"
                onClick={() => setSelectedAppointment(null)}
              >
                ×
              </button>
            </div>
            <div className="hbk-body">
              <div className="appointment-overview">
                <div className="overview-section">
                  <h3>Pet Information</h3>
                  <div className="info-grid">
                    <div className="info-item">
                      <label>Pet Name:</label>
                      <span>{selectedAppointment.petName}</span>
                    </div>
                    <div className="info-item">
                      <label>Type:</label>
                      <span>{selectedAppointment.petType}</span>
                    </div>
                    <div className="info-item">
                      <label>Breed:</label>
                      <span>{selectedAppointment.breed}</span>
                    </div>
                  </div>
                </div>
                
                <div className="overview-section">
                  <h3>Owner Information</h3>
                  <div className="info-grid">
                    <div className="info-item">
                      <label>Owner Name:</label>
                      <span>{selectedAppointment.owner}</span>
                    </div>
                    <div className="info-item">
                      <label>Phone:</label>
                      <span>{selectedAppointment.ownerPhone}</span>
                    </div>
                  </div>
                </div>
                
                <div className="overview-section">
                  <h3>Booking Details</h3>
                  <div className="info-grid">
                    <div className="info-item">
                      <label>Doctor:</label>
                      <span>{selectedAppointment.doctor}</span>
                    </div>
                    <div className="info-item">
                      <label>Date:</label>
                      <span>{selectedAppointment.appointmentDate}</span>
                    </div>
                    <div className="info-item">
                      <label>Time:</label>
                      <span>{selectedAppointment.appointmentTime}</span>
                    </div>
                    <div className="info-item">
                      <label>Service:</label>
                      <span>{selectedAppointment.service}</span>
                    </div>
                    <div className="info-item">
                      <label>Status:</label>
                      <span className={`status-badge ${getStatusColor(selectedAppointment.status)}`}>
                        <FontAwesomeIcon icon={getStatusIcon(selectedAppointment.status)} />
                        {selectedAppointment.status}
                      </span>
                    </div>
                  </div>
                </div>
                
                <div className="overview-section">
                  <h3>Notes</h3>
                  <div className="notes-section">
                    <p>{selectedAppointment.notes || "No notes provided"}</p>
                  </div>
                </div>
              </div>
              
              <div className="hbk-foot">
                <button className="secondary-btn" onClick={() => setSelectedAppointment(null)}>
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ReceptionistVeterinaryBookings;
