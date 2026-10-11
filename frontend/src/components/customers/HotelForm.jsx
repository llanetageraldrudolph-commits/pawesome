import React, { useState, useEffect, useCallback } from "react";
import { showConfirm, showWarning, showSuccess, showError, showReasonPrompt, CUSTOMER_CANCEL_REASONS } from "../../utils/alert.jsx";
import BookingReviewModal from "../shared/BookingReviewModal";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import PaymentUploadModal from "../../components/shared/PaymentUploadModal";
import catHotelImg from "../../assets/CATHOTEL.jpg";
import dogHotelImg from "../../assets/DOGHOTEL.jpg";
import daycareImg from "../../assets/PETDAYCARE.jpg";
import {
  faHotel,
  faPlus,
  faBed,
  faCalendarAlt,
  faPaw,
  faCheckCircle,
  faTimesCircle,
  faReceipt,
  faClipboardList,
} from "@fortawesome/free-solid-svg-icons";
import "./HotelForm.css";
import { apiRequest } from "../../api/client";
import { getDraft, clearDraft } from "../../utils/preBookingDraft";
import DatePickerInput from "../../components/shared/DatePickerInput";
import { formatDateOnly, parseDateOnly } from "../../utils/date";


const CATEGORY_CONFIG = {
  dog_hotel: { img: dogHotelImg, label: "Dog Hotel",  badge: "#f97316" },
  cat_hotel: { img: catHotelImg, label: "Cat Hotel",  badge: "#8b5cf6" },
  daycare:   { img: daycareImg,  label: "Daycare",    badge: "#10b981" },
  other:     { img: null,        label: "Other",      badge: "#64748b" },
};

const getRoomConfig = (room) => {
  const cat = room.hotel_category ||
    (room.room_type?.startsWith("dog") || room.room_type === "kennel" ? "dog_hotel" :
     room.room_type?.startsWith("cat") || room.room_type === "cattery" ? "cat_hotel" :
     room.room_type?.startsWith("daycare") ? "daycare" : "other");
  return CATEGORY_CONFIG[cat] || CATEGORY_CONFIG.other;
};

const normalizeList = (result, keys = []) => {
  if (Array.isArray(result)) return result;

  for (const key of keys) {
    if (Array.isArray(result?.[key])) return result[key];
    if (Array.isArray(result?.[key]?.data)) return result[key].data;
  }

  if (Array.isArray(result?.data)) return result.data;
  if (Array.isArray(result?.items)) return result.items;
  if (Array.isArray(result?.requests)) return result.requests;
  if (Array.isArray(result?.boarding_requests)) return result.boarding_requests;
  if (Array.isArray(result?.boardings?.data)) return result.boardings.data;
  if (Array.isArray(result?.care_logs)) return result.care_logs;

  return [];
};

const HotelForm = () => {
  const [activeTab, setActiveTab] = useState("book");
  const [myBookings, setMyBookings] = useState([]);
  const [pets, setPets] = useState([]);
  const [careLogs, setCareLogs] = useState({});
  const [uploadModal, setUploadModal] = useState({ open: false, endpoint: "", title: "", referenceNumber: "", paymentStatus: "", rejectionReason: "", paymentMethod: "gcash" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [availabilityLoading, setAvailabilityLoading] = useState(false);
  const [boardingAvailability, setBoardingAvailability] = useState(null);
  const [selectedRoom, setSelectedRoom] = useState(null);

  const [bookingForm, setBookingForm] = useState({
    pet_id: "",
    pet_name: "",
    pet_type: "",
    check_in_date: "",
    boarding_type: "standard",
    notes: "",
  });
  const [vaccinationCard, setVaccinationCard] = useState(null);
  const [vaccinationPreview, setVaccinationPreview] = useState(null);

  const fetchPets = useCallback(async () => {
    try {
      const result = await apiRequest("/customer/pets");
      setPets(normalizeList(result, ["pets"]));
    } catch {
      setPets([]);
    }
  }, []);

  const fetchMyBookings = useCallback(async () => {
    try {
      setLoading(true);
      setError("");
      const data = await apiRequest("/customer/boardings");
      setMyBookings(normalizeList(data, ["boarding_requests", "boardings"]));
    } catch (err) {
      console.error("Failed to load customer boardings:", {
        message: err?.message,
        status: err?.status,
        response: err?.response,
        url: err?.url,
      });
      setError(err.message || "Failed to load boarding requests.");
      setMyBookings([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPets();
    fetchMyBookings();
  }, [fetchPets, fetchMyBookings]);

  useEffect(() => {
    const draft = getDraft();
    if (!draft || draft.service_type !== "hotel") return;

    const updates = {};
    // Pet identity resolves to a registered pet once the list loads —
    // the draft's name/species are only matching hints, never submitted raw.
    if (draft.form_data?.pet_id) updates.pet_id = draft.form_data.pet_id;
    if (draft.form_data?.pet_name) updates.pet_name = draft.form_data.pet_name;
    if (draft.form_data?.pet_type) updates.pet_type = draft.form_data.pet_type;
    if (draft.form_data?.check_in_date) updates.check_in_date = draft.form_data.check_in_date;
    if (draft.form_data?.room_type) updates.boarding_type = draft.form_data.room_type;
    if (draft.form_data?.special_care_instructions) updates.notes = draft.form_data.special_care_instructions;

    setBookingForm((prev) => ({ ...prev, ...updates }));
    clearDraft();

    const merged = { ...bookingForm, ...updates };
    if (merged.check_in_date && (merged.pet_id || merged.pet_type)) {
      fetchBoardingAvailability(merged);
    }

    if (Object.keys(updates).length > 0) {
      showSuccess("We have restored your booking details. Please select your registered pet to continue.");
    }
  }, []);

  // Once pets finish loading, resolve a draft's pet hint to a real pet so the
  // booking is always linked — a restored name is never submitted as-is.
  useEffect(() => {
    if (pets.length === 0) return;

    if (bookingForm.pet_id) {
      // Draft carried a pet_id — fill derived display fields from the record.
      const selected = pets.find((p) => String(p.id) === String(bookingForm.pet_id));
      if (!selected || bookingForm.pet_name) return;
      const updatedForm = {
        ...bookingForm,
        pet_name: selected.name,
        pet_type: selected.species || selected.type || "",
      };
      setBookingForm(updatedForm);
      if (updatedForm.check_in_date) fetchBoardingAvailability(updatedForm);
      return;
    }

    if (!bookingForm.pet_name && !bookingForm.pet_type) return;

    const name = (bookingForm.pet_name || "").toLowerCase();
    const species = (bookingForm.pet_type || "").toLowerCase();
    const byName = name ? pets.filter((p) => (p.name || "").toLowerCase() === name) : [];
    const bySpecies = species
      ? pets.filter((p) => (p.species || p.type || "").toLowerCase() === species)
      : [];
    const pet = byName.length === 1 ? byName[0] : bySpecies.length === 1 ? bySpecies[0] : null;
    if (!pet) return;

    const updatedForm = {
      ...bookingForm,
      pet_id: pet.id,
      pet_name: pet.name,
      pet_type: pet.species || pet.type || "",
    };
    setBookingForm(updatedForm);
    if (updatedForm.check_in_date) fetchBoardingAvailability(updatedForm);
  }, [pets, bookingForm.pet_id, bookingForm.pet_name, bookingForm.pet_type]);

  const selectedPet = pets.find((pet) => String(pet.id) === String(bookingForm.pet_id));

  const calculateAge = (birthdate) => {
    if (!birthdate) return null;
    const today = new Date();
    const birth = new Date(birthdate);
    let age = today.getFullYear() - birth.getFullYear();
    const monthDiff = today.getMonth() - birth.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
      age--;
    }
    if (age <= 0) return "Less than 1 year";
    return `${age} year${age > 1 ? "s" : ""}`;
  };

  const getPetDisplayInfo = (pet) => {
    if (!pet) return null;
    const typeOfPet = pet.species || pet.type || "Pet";
    const birthdate = pet.birthdate || pet.birth_date || pet.date_of_birth;
    const age = calculateAge(birthdate);
    return {
      typeOfPet,
      birthdate,
      age,
    };
  };

  const petDisplayInfo = getPetDisplayInfo(selectedPet);

  const handleRoomSelect = (room) => {
    setSelectedRoom(room);
    const isLegacy = String(room.id).startsWith("hotel_");
    const realId = isLegacy ? String(room.id).replace("hotel_", "") : room.id;
    setBookingForm(prev => ({
      ...prev,
      room_id: isLegacy ? undefined : realId,
      hotel_room_id: isLegacy ? realId : undefined,
    }));
  };

  const [reviewOpen, setReviewOpen] = useState(false);

  const handleCreateBooking = (e) => {
    e.preventDefault();

    if (!selectedRoom) {
      setError("Please select an available room for your stay.");
      showWarning("Please select an available room for your stay.");
      return;
    }

    if (boardingAvailability && !boardingAvailability.rooms?.find(room => room.id === selectedRoom.id && room.available)) {
      setError("Selected room is no longer available. Please choose another room.");
      showWarning("Selected room is no longer available. Please choose another room.");
      return;
    }

    if (!bookingForm.pet_id || !selectedPet) {
      setError("Please select one of your registered pets for this booking.");
      showWarning("Please select one of your registered pets for this booking.");
      return;
    }

    setReviewOpen(true);
  };

  // Vaccination card is optional
  const confirmBooking = async () => {
    try {
      setLoading(true);
      setError("");

      const formData = new FormData();
      formData.append("pet_id", bookingForm.pet_id);
      formData.append("pet_name", selectedPet.name || "");
      formData.append("pet_type", selectedPet.type || selectedPet.species || "");
      formData.append("pet_breed", selectedPet.breed || "");
      formData.append("check_in_date", bookingForm.check_in_date);
      formData.append("number_of_days", "1");
      if (bookingForm.room_id) {
        formData.append("room_id", bookingForm.room_id);
      }
      if (bookingForm.hotel_room_id) {
        formData.append("hotel_room_id", bookingForm.hotel_room_id);
      }
      formData.append("notes", bookingForm.notes || "");
      if (vaccinationCard) {
        formData.append("vaccination_card", vaccinationCard);
      }

      await apiRequest("/customer/boardings", {
        method: "POST",
        body: formData,
      });

      setReviewOpen(false);
      setSuccessMessage("Pet boarding request submitted successfully.");
      showSuccess("Pet boarding request submitted successfully.");
      setBookingForm({
        pet_id: "",
        pet_name: "",
        pet_type: "",
        check_in_date: "",
        boarding_type: "standard",
        notes: "",
      });
      setVaccinationCard(null);
      setVaccinationPreview(null);
      await fetchMyBookings();
      setActiveTab("my-bookings");
    } catch (err) {
      setError(err.message || "Failed to create boarding request.");
      showError(err.message || "Failed to create boarding request.");
    } finally {
      setLoading(false);
    }
  };

  const handleCancelBooking = async (bookingId) => {
    const reason = await showReasonPrompt(
      "Cancel this pending boarding request? Please select a reason — it will be recorded.",
      "Cancel Boarding Request",
      "Yes, Cancel",
      CUSTOMER_CANCEL_REASONS
    );
    if (reason === null) return;

    try {
      setLoading(true);
      await apiRequest(`/customer/boarding-requests/${bookingId}/cancel`, { method: "POST", body: JSON.stringify({ reason }) });
      setSuccessMessage("Boarding request cancelled.");
      showSuccess("Boarding request cancelled.");
      await fetchMyBookings();
    } catch (err) {
      setError(err.message || "Failed to cancel reservation.");
      showError(err.message || "Failed to cancel reservation.");
    } finally {
      setLoading(false);
    }
  };

  const openPaymentModal = (booking) => {
    setUploadModal({
      open: true,
      endpoint: `/customer/boarding-requests/${booking.id}/payment-proof`,
      title: `Boarding — ${booking.pet_name || "Pet"}`,
      referenceNumber: booking.payment_reference || "",
      paymentStatus: String(booking.payment_status || "").toLowerCase(),
      rejectionReason: booking.rejection_reason || "",
      paymentMethod: booking.payment_method || "gcash",
    });
  };

  const fetchCareLogs = async (bookingId) => {
    try {
      const data = await apiRequest(`/customer/boarding-requests/${bookingId}/care-logs`);
      setCareLogs((prev) => ({ ...prev, [bookingId]: normalizeList(data, ["care_logs"]) }));
    } catch (err) {
      setError(err.message || "Failed to load care logs.");
    }
  };

  const getStatusBadge = (status) => {
    const styles = {
      pending: { bg: "#fef3c7", color: "#d97706" },
      approved: { bg: "#dbeafe", color: "#2563eb" },
      scheduled: { bg: "#ede9fe", color: "#7c3aed" },
      checked_in: { bg: "#dcfce7", color: "#16a34a" },
      in_care: { bg: "#dcfce7", color: "#16a34a" },
      ready_for_pickup: { bg: "#cffafe", color: "#0891b2" },
      completed: { bg: "#fce7f3", color: "#be185d" },
      rejected: { bg: "#fee2e2", color: "#dc2626" },
      cancelled: { bg: "#f3f4f6", color: "#4b5563" },
    };
    return styles[status] || styles.pending;
  };

  const canUploadPayment = (booking) =>
    ["approved", "scheduled"].includes(booking.status) &&
    ["unpaid", "rejected"].includes(booking.payment_status || "unpaid");

  const fetchBoardingAvailability = async (form = bookingForm) => {
    const pet = pets.find((p) => String(p.id) === String(form.pet_id));
    const species = (pet?.species || pet?.type || form.pet_type || "").toLowerCase().trim();
    if (!form?.check_in_date || !species) {
      setBoardingAvailability(null);
      return;
    }

    try {
      setAvailabilityLoading(true);
      setError("");

      // Same-day stay: check-out equals check-in
      const params = new URLSearchParams({
        species,
        check_in_date: form.check_in_date,
        check_out_date: form.check_in_date,
      });

      if (form.pet_id) {
        params.append('pet_id', form.pet_id);
      }

      if (form.room_type) {
        params.append('room_type', form.room_type);
      }

      const data = await apiRequest(`/boarding/rooms/available?${params}`);

      if (data.success) {
        setBoardingAvailability(data);
      } else {
        setBoardingAvailability(null);
        setError(data.message || "No rooms available for the selected dates.");
      }
    } catch (err) {
      setError(err.message || "Failed to check availability.");
      setBoardingAvailability(null);
    } finally {
      setAvailabilityLoading(false);
    }
  };

  const handleChange = (e) => {
    const { name, value } = e.target;

    // Pet identity always comes from the selected registered pet — never
    // typed manually — so the booking stays linked to a real pets row.
    if (name === "pet_id") {
      const pet = pets.find((item) => String(item.id) === String(value));
      const updatedForm = {
        ...bookingForm,
        pet_id: value,
        pet_name: pet?.name || "",
        pet_type: pet?.species || pet?.type || "",
      };
      setBookingForm((prev) => ({
        ...prev,
        pet_id: value,
        pet_name: pet?.name || "",
        pet_type: pet?.species || pet?.type || "",
      }));
      setSelectedRoom(null);
      if (value && updatedForm.check_in_date && updatedForm.pet_type) {
        fetchBoardingAvailability(updatedForm);
      } else {
        setBoardingAvailability(null);
      }
      return;
    }

    setBookingForm((prev) => ({ ...prev, [name]: value }));

    if (name === "check_in_date") {
      const updatedForm = { ...bookingForm, [name]: value };
      // A previous selection is only valid for the exact pet+date pair
      setSelectedRoom(null);
      if (value && updatedForm.check_in_date && updatedForm.pet_id) {
        // Pass updatedForm — bookingForm state here is still pre-change
        fetchBoardingAvailability(updatedForm);
      } else {
        setBoardingAvailability(null);
      }
    }
  };

  // Calculate total amount when room is selected (same-day stay = 1 day)
  const calculateTotal = () => {
    if (!selectedRoom || !bookingForm.check_in_date) {
      return { total: 0, days: 0, dailyRate: 0 };
    }

    const days = 1;
    const roomSubtotal = selectedRoom.daily_rate * days;
    const total = roomSubtotal;

    return {
      total,
      days,
      dailyRate: selectedRoom.daily_rate,
      roomSubtotal,
    };
  };

  const pricing = calculateTotal();

  return (
    <div className="customer-hotel-reservation">
      <header className="hotel-header">
        <div>
          <h3><FontAwesomeIcon icon={faHotel} /> Pet Hotel</h3>
        </div>
      </header>

      {error && (
        <div className="hotel-error">
          <span>x</span>
          <p>{error}</p>
        </div>
      )}
      {successMessage && (
        <div className="alert alert-success">
          <FontAwesomeIcon icon={faCheckCircle} /> {successMessage}
        </div>
      )}

      <div className="hotel-tabs">
        <button className={`hotel-tab ${activeTab === "book" ? "active" : ""}`} onClick={() => setActiveTab("book")}>
          <FontAwesomeIcon icon={faPlus} /> New Reservation
        </button>
        <button className={`hotel-tab ${activeTab === "my-bookings" ? "active" : ""}`} onClick={() => setActiveTab("my-bookings")}>
          <FontAwesomeIcon icon={faBed} /> My Bookings ({myBookings.length})
        </button>
      </div>

      {activeTab === "book" && (
        <div className="book-tab">
          <div className="booking-form-section">
            <h3><FontAwesomeIcon icon={faCalendarAlt} /> Boarding Request</h3>

            <form onSubmit={handleCreateBooking}>
              <div className="form-group">
                <label>Pet *</label>
                <select name="pet_id" value={bookingForm.pet_id} onChange={handleChange} required>
                  <option value="">Select your pet</option>
                  {pets.map((pet) => {
                    const info = getPetDisplayInfo(pet);
                    return (
                      <option key={pet.id} value={pet.id}>
                        {pet.name} — {info?.typeOfPet || "Pet"}
                        {info?.age ? ` (${info.age})` : ""}
                      </option>
                    );
                  })}
                </select>
                {pets.length === 0 && (
                  <p className="hotel-no-pets-notice">
                    You need a registered pet to book a hotel stay.{" "}
                    <a href="/customer/pets">Register a pet first</a>, then come
                    back to book.
                  </p>
                )}
              </div>

              {selectedPet && petDisplayInfo && (
                <div className="hotel-selected-pet-info">
                  <p><strong>Type of Pet:</strong> {petDisplayInfo.typeOfPet}</p>
                  {petDisplayInfo.birthdate && (
                    <p><strong>Birthdate:</strong> {new Date(petDisplayInfo.birthdate).toLocaleDateString()}</p>
                  )}
                  {petDisplayInfo.age && (
                    <p><strong>Age:</strong> {petDisplayInfo.age}</p>
                  )}
                </div>
              )}

              <div className="form-row">
                <div className="form-group">
                  <label>Stay Date *</label>
                  <DatePickerInput
                    selected={parseDateOnly(bookingForm.check_in_date)}
                    onChange={(date) =>
                      handleChange({
                        target: {
                          name: "check_in_date",
                          value: formatDateOnly(date),
                        },
                      })
                    }
                    placeholderText="mm/dd/yyyy"
                    minDate={new Date()}
                    required
                  />
                </div>
                <div className="form-group">
                  <label>Stay Duration</label>
                  <input type="text" value="Same-day stay — check-out by 6:00 PM" disabled readOnly />
                </div>
              </div>

              {/* Availability Display */}
              {boardingAvailability && (
                <div className="hotel-availability">
                  <h4>Available Rooms for Your Stay</h4>
                  {boardingAvailability.rooms && boardingAvailability.rooms.length > 0 ? (
                    <div className="rooms-grid">
                      {boardingAvailability.rooms.map((room) => {
                        const cfg = getRoomConfig(room);
                        return (
                          <button
                            key={room.id}
                            type="button"
                            className={`room-card ${!room.available ? 'unavailable' : ''} ${selectedRoom?.id === room.id ? 'selected' : ''}`}
                            onClick={() => room.available && handleRoomSelect(room)}
                            disabled={!room.available}
                          >
                            <div className="room-card-img-wrap">
                              {cfg.img
                                ? <img src={cfg.img} alt={cfg.label} className="room-card-img" />
                                : <div className="room-card-img-placeholder"><FontAwesomeIcon icon={faBed} /></div>
                              }
                              <span className="room-card-badge" style={{ background: cfg.badge }}>{cfg.label}</span>
                              {!room.available && <div className="room-card-unavailable-overlay">Unavailable</div>}
                            </div>
                            <div className="room-card-body">
                              <div className="room-header">
                                <span className="room-name">{room.room_name}</span>
                                <span className="room-type">{room.room_type?.replace(/_/g, ' ')}</span>
                              </div>
                              <div className="room-details">
                                {room.capacity || room.max_capacity ? (
                                  <span className="room-capacity">👥 Capacity: {room.capacity ?? room.max_capacity}</span>
                                ) : null}
                                <span className="room-rate">₱{Number(room.daily_rate).toLocaleString('en-PH')}/day</span>
                                {room.available_rooms != null && (
                                  <span className="room-slots">{room.available_rooms} slot{room.available_rooms !== 1 ? 's' : ''} left</span>
                                )}
                              </div>
                              <span className={`room-status ${room.available ? 'avail' : 'unavail'}`}>
                                {room.available ? '✓ Available' : room.reason || 'Not Available'}
                              </span>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="no-availability">
                      <p>No rooms or kennels are available for the selected date range.</p>
                    </div>
                  )}
                </div>
              )}

              {availabilityLoading && (
                <div className="availability-loading">
                  <span>Checking room availability...</span>
                </div>
              )}

              {/* Pricing Summary */}
              {selectedRoom && pricing.total > 0 && (
                <div className="pricing-summary">
                  <h4><FontAwesomeIcon icon={faReceipt} /> Pricing Summary</h4>
                  <div className="pricing-details">
                    <div className="pricing-row">
                      <span>Room:</span>
                      <span>{selectedRoom.room_name}</span>
                    </div>
                    <div className="pricing-row">
                      <span>Daily Rate:</span>
                      <span>₱{pricing.dailyRate}</span>
                    </div>
                    <div className="pricing-row">
                      <span>Duration:</span>
                      <span>Same-day stay</span>
                    </div>
                    <div className="pricing-row">
                      <span>Room Subtotal:</span>
                      <span>₱{pricing.roomSubtotal}</span>
                    </div>
                    <div className="pricing-row total">
                      <span>Total Amount:</span>
                      <span>₱{pricing.total}</span>
                    </div>
                  </div>
                </div>
              )}

              <div className="form-group">
                <label>Notes</label>
                <textarea name="notes" value={bookingForm.notes} onChange={handleChange} rows={3} placeholder="Any additional notes..." />
              </div>

              <div className="form-group">
                <label>Vaccination Card (Optional)</label>
                <input
                  type="file"
                  accept="image/*,.pdf"
                  onChange={(e) => {
                    const file = e.target.files?.[0] || null;
                    setVaccinationCard(file);
                    if (file) {
                      const reader = new FileReader();
                      reader.onloadend = () => setVaccinationPreview(reader.result);
                      reader.readAsDataURL(file);
                    } else {
                      setVaccinationPreview(null);
                    }
                  }}
                />
                {vaccinationPreview && (
                  <div className="vaccination-preview">
                    <img src={vaccinationPreview} alt="Vaccination card preview" />
                  </div>
                )}
              </div>

              <button type="submit" disabled={loading}>
                {loading ? "Submitting..." : "Submit Boarding Request"}
              </button>
            </form>
          </div>
        </div>
      )}

      {activeTab === "my-bookings" && (
        <div className="my-bookings-tab">
          {myBookings.length === 0 ? (
            <div className="no-bookings">
              <FontAwesomeIcon icon={faBed} />
              <p>No boarding requests yet.</p>
              <button onClick={() => setActiveTab("book")}><FontAwesomeIcon icon={faPlus} /> Make Reservation</button>
            </div>
          ) : (
            <div className="bookings-list">
              {myBookings.map((booking) => {
                const statusStyle = getStatusBadge(booking.status);
                const logs = careLogs[booking.id] || [];

                return (
                  <div key={booking.id} className="booking-card">
                    <div className="booking-card-top">
                      <div className="booking-card-avatar">
                        <FontAwesomeIcon icon={faPaw} />
                      </div>
                      <div className="booking-card-meta">
                        <h4>{booking.pet?.name || booking.pet_name || "Pet"}</h4>
                        <p>Boarding #{booking.id}</p>
                      </div>
                      <span className="status-badge" style={{ backgroundColor: statusStyle.bg, color: statusStyle.color }}>
                        {booking.status}
                      </span>
                    </div>

                    <div className="booking-card-body">
                      <div className="booking-card-grid">
                        <div>
                          <span className="bcg-label"><FontAwesomeIcon icon={faBed} /> Room</span>
                          <span className="bcg-value">{booking.hotel_room?.name || booking.hotel_room?.room_number || booking.boarding_type || "Pending"}</span>
                        </div>
                        <div>
                          <span className="bcg-label"><FontAwesomeIcon icon={faCalendarAlt} /> Stay</span>
                          <span className="bcg-value">{booking.check_in?.slice(0, 10)} — {booking.check_out?.slice(0, 10)}</span>
                        </div>
                        <div>
                          <span className="bcg-label"><FontAwesomeIcon icon={faReceipt} /> Payment</span>
                          <span className={`bcg-payment ${String(booking.payment_status || "unpaid").toLowerCase()}`}>{booking.payment_status || "unpaid"}</span>
                        </div>
                        <div>
                          <span className="bcg-label">Total</span>
                          <span className="bcg-value">₱{Number(booking.total_amount || 0).toLocaleString("en-PH", { minimumFractionDigits: 2 })}</span>
                        </div>
                      </div>
                      {booking.rejection_reason && (
                        <div className="booking-rejection">{booking.rejection_reason}</div>
                      )}
                    </div>

                    <div className="booking-card-actions">
                      {booking.status === "pending" && (
                        <button className="bc-action cancel" onClick={() => handleCancelBooking(booking.id)} disabled={loading}>
                          <FontAwesomeIcon icon={faTimesCircle} /> Cancel
                        </button>
                      )}

                      {canUploadPayment(booking) && (
                        <button className="bc-action primary" type="button" onClick={() => openPaymentModal(booking)}>
                          <FontAwesomeIcon icon={faReceipt} /> Upload Payment
                        </button>
                      )}

                      {["checked_in", "in_care", "ready_for_pickup", "completed"].includes(booking.status) && (
                        <button className="bc-action primary" type="button" onClick={() => fetchCareLogs(booking.id)}>
                          <FontAwesomeIcon icon={faClipboardList} /> Care Logs
                        </button>
                      )}
                    </div>

                    {logs.length > 0 && (
                      <div className="care-log-list">
                        {logs.map((log) => (
                          <div key={log.id} className="care-log-item">
                            <strong>{log.title || log.log_type}</strong>
                            <p>{log.notes}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <PaymentUploadModal
        open={uploadModal.open}
        onClose={() => setUploadModal({ open: false, endpoint: "", title: "", referenceNumber: "", paymentStatus: "", rejectionReason: "", paymentMethod: "gcash" })}
        onSuccess={fetchMyBookings}
        endpoint={uploadModal.endpoint}
        title={uploadModal.title}
        referenceNumber={uploadModal.referenceNumber}
        paymentStatus={uploadModal.paymentStatus}
        rejectionReason={uploadModal.rejectionReason}
        paymentMethod={uploadModal.paymentMethod}
      />

      <BookingReviewModal
        open={reviewOpen}
        onClose={() => setReviewOpen(false)}
        onConfirm={confirmBooking}
        loading={loading}
        badge="Pet Hotel"
        pet={selectedPet ? {
          name: selectedPet.name,
          species: selectedPet.species || selectedPet.type,
          breed: selectedPet.breed,
          age: petDisplayInfo?.age,
        } : null}
        details={[
          { label: "Check-in", value: bookingForm.check_in_date && new Date(`${bookingForm.check_in_date}T00:00:00`).toLocaleDateString("en-PH", { weekday: "short", month: "short", day: "numeric", year: "numeric" }) },
          { label: "Stay length", value: `${pricing.days} day${pricing.days !== 1 ? "s" : ""}` },
          { label: "Room", value: selectedRoom?.room_name },
          { label: "Room type", value: selectedRoom?.room_type?.replace(/_/g, " ") },
          selectedRoom?.capacity || selectedRoom?.max_capacity
            ? { label: "Capacity", value: `${selectedRoom.capacity ?? selectedRoom.max_capacity} pet${(selectedRoom.capacity ?? selectedRoom.max_capacity) !== 1 ? "s" : ""}` }
            : null,
          bookingForm.boarding_type ? { label: "Boarding type", value: bookingForm.boarding_type.replace(/_/g, " ") } : null,
        ].filter(Boolean)}
        pricing={selectedRoom ? {
          rows: [
            { label: `${selectedRoom.room_name || "Room"} — ₱${Number(selectedRoom.daily_rate).toLocaleString("en-PH")}/day × ${pricing.days}`, value: `₱${Number(pricing.roomSubtotal).toLocaleString("en-PH", { minimumFractionDigits: 2 })}` },
          ],
          total: `₱${Number(pricing.total).toLocaleString("en-PH", { minimumFractionDigits: 2 })}`,
        } : null}
        notes={bookingForm.notes}
        attachment={vaccinationCard ? {
          name: vaccinationCard.name,
          previewUrl: vaccinationPreview,
          isImage: vaccinationCard.type?.startsWith("image/"),
        } : null}
      />
    </div>
  );
};

export default HotelForm;
