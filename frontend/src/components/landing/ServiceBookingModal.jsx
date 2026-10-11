import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faTimes, faHotel, faScissors, faStethoscope, faCalendarAlt, faClock, faPaw, faPaperPlane, faPlusCircle, faTimesCircle, faUser, faEnvelope, faBed, faHeartbeat } from "@fortawesome/free-solid-svg-icons";
import "../../styles/bookingModal.css";
import "./ServiceBookingModal.css";
import DatePickerInput from "../shared/DatePickerInput";
import { apiRequest } from "../../api/client";
import { useAuth } from "../../context/AuthContext";
import { formatDateOnly, parseDateOnly } from "../../utils/date";
import { saveDraft, saveServiceIntent, getDraft, clearDraft } from "../../utils/preBookingDraft";
import { showSuccess, showError } from "../../utils/alert.jsx";
import BookingReviewModal from "../shared/BookingReviewModal";

const SERVICE_CONFIG = {
  hotel: { title: "Book Pet Hotel", icon: faHotel, accent: "hotel-accent" },
  grooming: { title: "Book Grooming", icon: faScissors, accent: "grooming-accent" },
  vet: { title: "Book Vet Visit", icon: faStethoscope, accent: "vet-accent" },
};

const ROOM_TYPES = [{ value: "", label: "Select room type" }, { value: "standard", label: "Standard Room" }, { value: "deluxe", label: "Deluxe Room" }, { value: "suite", label: "Suite" }, { value: "kennel", label: "Kennel" }, { value: "cattery", label: "Cattery" }];
const GROOMING_TYPES = [{ value: "", label: "Select grooming service" }, { value: "full_grooming", label: "Full Grooming" }, { value: "bath_and_brush", label: "Bath and Brush" }, { value: "nail_trim", label: "Nail Trim" }, { value: "ear_cleaning", label: "Ear Cleaning" }, { value: "teeth_cleaning", label: "Teeth Cleaning" }, { value: "spa_treatment", label: "Spa Treatment" }];
const VET_TYPES = [{ value: "", label: "Select veterinary service" }, { value: "consultation", label: "General Consultation" }, { value: "vaccination", label: "Vaccination" }, { value: "checkup", label: "Routine Checkup" }, { value: "dental", label: "Dental Care" }, { value: "surgery", label: "Surgery" }, { value: "emergency", label: "Emergency Care" }, { value: "diagnostics", label: "Diagnostics / Lab Tests" }];
const ENERGY_LEVELS = [{ value: "", label: "Select energy level" }, { value: "normal", label: "Normal" }, { value: "lethargic", label: "Lethargic" }, { value: "hyperactive", label: "Hyperactive" }, { value: "fluctuating", label: "Fluctuating" }];
const APPETITE_OPTIONS = [{ value: "", label: "Select appetite condition" }, { value: "normal", label: "Normal" }, { value: "increased", label: "Increased" }, { value: "decreased", label: "Decreased" }, { value: "none", label: "Not eating at all" }];
const URGENCY_LEVELS = [{ value: "", label: "Select urgency" }, { value: "low", label: "Low — Routine checkup" }, { value: "medium", label: "Medium — Should be seen within a few days" }, { value: "high", label: "High — Needs attention soon" }, { value: "critical", label: "Critical — Emergency" }];

const generateTimeSlots = () => {
  const slots = [];
  const start = new Date(); start.setHours(9, 0, 0, 0);
  const end = new Date(); end.setHours(18, 0, 0, 0);
  while (start < end) {
    const value = start.toTimeString().slice(0, 5);
    const label = start.toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit", hour12: true });
    slots.push({ value, label });
    start.setMinutes(start.getMinutes() + 30);
  }
  return slots;
};

const timeSlots = generateTimeSlots();
const nextDateOnly = (value) => {
  const date = parseDateOnly(value);
  if (!date) return "";
  date.setDate(date.getDate() + 1);
  return formatDateOnly(date);
};
const getRoomTypeKey = (room) => {
  const type = String(room?.type || "").toLowerCase();
  return ROOM_TYPES.find((option) => option.value && type.includes(option.value))?.value || "";
};

const getInitialForm = (serviceType) => {
  const base = { customer_name: "", customer_email: "", pet_id: "", pet_name: "", pet_type: "" };
  if (serviceType === "hotel") return { ...base, check_in_date: "", preferred_time: "", room_type: "", special_care_instructions: "" };
  if (serviceType === "grooming") return { ...base, grooming_service_type: "", preferred_date: "", preferred_time: "", special_grooming_instructions: "" };
  return { ...base, veterinary_service_type: "", preferred_date: "", preferred_time: "", main_reason_for_visit: "", flu_symptoms: "", observed_issues: "", appetite_condition: "", energy_level: "", symptom_duration: "", medications_taken: "", recent_exposure: "", urgency_level: "" };
};

const ServiceBookingModal = ({ serviceType, onClose }) => {
  const navigate = useNavigate();
  const { isAuthenticated, user, role } = useAuth();
  const isCustomer = role === "customer";
  const canBook = isAuthenticated && isCustomer && Boolean(user?.email_verified_at);
  const needsVerification = isAuthenticated && isCustomer && !user?.email_verified_at;
  const config = SERVICE_CONFIG[serviceType];
  const [formData, setFormData] = useState(() => getInitialForm(serviceType));
  const [loading, setLoading] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [availabilityLoading, setAvailabilityLoading] = useState(false);
  const [availableTimeSlots, setAvailableTimeSlots] = useState([]);
  const [hotelAvailabilityLoading, setHotelAvailabilityLoading] = useState(false);
  const [availableRoomTypes, setAvailableRoomTypes] = useState(null);
  const [hotelAvailabilityError, setHotelAvailabilityError] = useState("");
  const [showHealthInfo, setShowHealthInfo] = useState(false);
  const [errors, setErrors] = useState({});
  const [pets, setPets] = useState([]);

  useEffect(() => {
    const draft = getDraft();
    if (draft?.service_type !== serviceType || !draft.form_data) return;
    setFormData((prev) => ({ ...prev, ...draft.form_data }));
  }, [serviceType]);

  // Logged-in customers book against their registered pets — no typed names.
  useEffect(() => {
    if (!canBook) return;
    let cancelled = false;
    apiRequest("/customer/pets")
      .then((data) => {
        if (cancelled) return;
        const list = Array.isArray(data) ? data : data?.pets || data?.data || [];
        setPets(Array.isArray(list) ? list : []);
      })
      .catch(() => { if (!cancelled) setPets([]); });
    return () => { cancelled = true; };
  }, [canBook]);

  // Once pets load, resolve a draft's pet hint (name/species) to a real pet.
  useEffect(() => {
    if (pets.length === 0 || formData.pet_id) return;
    if (!formData.pet_name && !formData.pet_type) return;

    const name = (formData.pet_name || "").toLowerCase();
    const species = (formData.pet_type || "").toLowerCase();
    const byName = name ? pets.filter((p) => (p.name || "").toLowerCase() === name) : [];
    const bySpecies = species
      ? pets.filter((p) => (p.species || p.type || "").toLowerCase() === species)
      : [];
    const pet = byName.length === 1 ? byName[0] : bySpecies.length === 1 ? bySpecies[0] : null;
    if (!pet) return;

    setFormData((prev) => ({
      ...prev,
      pet_id: pet.id,
      pet_name: pet.name,
      pet_type: pet.species || pet.type || "",
    }));
  }, [pets, formData.pet_id, formData.pet_name, formData.pet_type]);

  useEffect(() => {
    if (isCustomer && user?.name) {
      setFormData((prev) => ({ ...prev, customer_name: user.name || "", customer_email: user.email || "" }));
    }
  }, [isCustomer, user]);

  useEffect(() => {
    if (serviceType === "hotel") {
      setAvailabilityLoading(false);
      return;
    }
    const date = formData.preferred_date;
    const selectedService = (serviceType === "grooming" ? GROOMING_TYPES : VET_TYPES)
      .find((option) => option.value === (serviceType === "grooming" ? formData.grooming_service_type : formData.veterinary_service_type));
    if (!date || !selectedService?.value) {
      setAvailableTimeSlots([]);
      setAvailabilityLoading(false);
      return;
    }

    const controller = new AbortController();
    const endpoint = serviceType === "grooming" ? "grooming" : "veterinary";
    setAvailabilityLoading(true);
    apiRequest(`/availability/${endpoint}?date=${encodeURIComponent(date)}&service_name=${encodeURIComponent(selectedService.label)}`, { signal: controller.signal })
      .then((data) => {
        const slots = data.slots || [];
        setAvailableTimeSlots(slots);
        setFormData((prev) => slots.some((slot) => slot.time === prev.preferred_time && slot.available)
          ? prev
          : { ...prev, preferred_time: "" });
        setAvailabilityLoading(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          // Fall back to the full slot list — the backend still validates at submit
          setAvailableTimeSlots(timeSlots.map((slot) => ({ time: slot.value, label: slot.label, available: true })));
          setAvailabilityLoading(false);
        }
      });
    return () => controller.abort();
  }, [serviceType, formData.preferred_date, formData.grooming_service_type, formData.veterinary_service_type]);

  useEffect(() => {
    if (serviceType !== "hotel" || !formData.check_in_date) {
      setHotelAvailabilityLoading(false);
      setAvailableRoomTypes(null);
      setHotelAvailabilityError("");
      return undefined;
    }

    const checkOutDate = nextDateOnly(formData.check_in_date);
    const controller = new AbortController();
    setHotelAvailabilityLoading(true);
    setAvailableRoomTypes(null);
    setHotelAvailabilityError("");
    apiRequest(`/availability/boarding?check_in=${encodeURIComponent(formData.check_in_date)}&check_out=${encodeURIComponent(checkOutDate)}`, { signal: controller.signal })
      .then((data) => {
        const rooms = Array.isArray(data.rooms) ? data.rooms : [];
        const roomTypes = [...new Set(rooms.filter((room) => room.available).map(getRoomTypeKey).filter(Boolean))];
        setAvailableRoomTypes(roomTypes);
        setHotelAvailabilityError(roomTypes.length ? "" : "No rooms are available for this stay date.");
        setFormData((prev) => prev.room_type && !roomTypes.includes(prev.room_type) ? { ...prev, room_type: "" } : prev);
        setHotelAvailabilityLoading(false);
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setAvailableRoomTypes([]);
          setHotelAvailabilityError(error.message || "Could not confirm room availability.");
          setHotelAvailabilityLoading(false);
        }
      });
    return () => controller.abort();
  }, [serviceType, formData.check_in_date]);

  useEffect(() => {
    const handleEsc = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handleEsc);
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", handleEsc); document.body.style.overflow = ""; };
  }, [onClose]);

  const handleChange = (e) => {
    const { name, value } = e.target;
    if (name === "pet_id") {
      const pet = pets.find((item) => String(item.id) === String(value));
      setFormData((prev) => ({
        ...prev,
        pet_id: value,
        pet_name: pet?.name || "",
        pet_type: pet?.species || pet?.type || "",
      }));
      setErrors((prev) => ({ ...prev, pet_id: "" }));
      return;
    }
    setFormData((prev) => ({
      ...prev,
      [name]: value,
      ...(name === "grooming_service_type" || name === "veterinary_service_type" ? { preferred_time: "" } : {}),
    }));
    setErrors((prev) => ({ ...prev, [name]: "" }));
  };
  const handleDateChange = (name, date) => {
    setFormData((prev) => ({
      ...prev,
      [name]: formatDateOnly(date),
      ...(name === "preferred_date" ? { preferred_time: "" } : name === "check_in_date" ? { room_type: "" } : {}),
    }));
    setErrors((prev) => ({ ...prev, [name]: "" }));
  };

  const validate = () => {
    const ne = {};
    if (!formData.customer_name.trim()) ne.customer_name = "Customer name is required.";
    if (!formData.customer_email.trim()) { ne.customer_email = "Email is required."; } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.customer_email)) { ne.customer_email = "Enter a valid email address."; }
    if (canBook) {
      if (!formData.pet_id) ne.pet_id = "Select one of your registered pets.";
    } else if (!formData.pet_type.trim()) {
      ne.pet_type = "Pet type is required.";
    }
    if (serviceType === "hotel") {
      if (!formData.check_in_date) ne.check_in_date = "Stay date is required.";
      else if (canBook) {
        if (hotelAvailabilityLoading) ne.check_in_date = "Checking room availability...";
        else if (!availableRoomTypes?.length) ne.check_in_date = hotelAvailabilityError || "No rooms are available for this stay date.";
      }
      if (canBook && formData.room_type && availableRoomTypes && !availableRoomTypes.includes(formData.room_type)) ne.room_type = "Choose an available room type.";
      if (!formData.preferred_time) ne.preferred_time = "Preferred time is required.";
    }
    if (serviceType === "grooming") {
      if (!formData.grooming_service_type) ne.grooming_service_type = "Grooming service type is required.";
      if (!formData.preferred_date) ne.preferred_date = "Preferred date is required.";
      if (!formData.preferred_time) ne.preferred_time = "Preferred time is required.";
      else if (!availableTimeSlots.some((slot) => slot.time === formData.preferred_time && slot.available)) ne.preferred_time = "Choose an available time slot.";
    }
    if (serviceType === "vet") {
      if (!formData.veterinary_service_type) ne.veterinary_service_type = "Veterinary service type is required.";
      if (!formData.preferred_date) ne.preferred_date = "Preferred date is required.";
      if (!formData.preferred_time) ne.preferred_time = "Preferred time is required.";
      else if (!availableTimeSlots.some((slot) => slot.time === formData.preferred_time && slot.available)) ne.preferred_time = "Choose an available time slot.";
      if (!formData.main_reason_for_visit.trim()) ne.main_reason_for_visit = "Reason for visit is required.";
    }
    setErrors(ne);
    return Object.keys(ne).length === 0;
  };

  const buildPayload = useCallback(() => {
    const selectedPet = pets.find((p) => String(p.id) === String(formData.pet_id));
    const base = { customer_name: formData.customer_name.trim(), customer_email: formData.customer_email.trim(), pet_id: selectedPet?.id || formData.pet_id, pet_name: selectedPet?.name || "", pet_type: selectedPet?.species || selectedPet?.type || formData.pet_type.trim() };
    if (serviceType === "hotel") return { ...base, request_type: "hotel", service_name: "Pet Hotel", requested_date: formData.check_in_date, requested_time: formData.preferred_time, check_in_date: formData.check_in_date, check_out_date: formData.check_in_date, room_type: formData.room_type, notes: formData.special_care_instructions || "", special_request: formData.special_care_instructions || "" };
    if (serviceType === "grooming") return { ...base, request_type: "grooming", service_name: formData.grooming_service_type, requested_date: formData.preferred_date, requested_time: formData.preferred_time, notes: formData.special_grooming_instructions || "", special_request: formData.special_grooming_instructions || "" };
    const healthParts = [];
    if (formData.flu_symptoms) healthParts.push(`Flu-like symptoms: ${formData.flu_symptoms}`);
    if (formData.observed_issues) healthParts.push(`Observed issues: ${formData.observed_issues}`);
    if (formData.appetite_condition) healthParts.push(`Appetite: ${formData.appetite_condition}`);
    if (formData.energy_level) healthParts.push(`Energy: ${formData.energy_level}`);
    if (formData.symptom_duration) healthParts.push(`Duration: ${formData.symptom_duration}`);
    if (formData.medications_taken) healthParts.push(`Medications: ${formData.medications_taken}`);
    if (formData.recent_exposure) healthParts.push(`Recent exposure: ${formData.recent_exposure}`);
    if (formData.urgency_level) healthParts.push(`Urgency: ${formData.urgency_level}`);
    const notes = [formData.main_reason_for_visit || ""];
    if (healthParts.length > 0) { notes.push("Additional health information:"); notes.push(...healthParts); }
    return { ...base, request_type: "vet", service_name: formData.veterinary_service_type, requested_date: formData.preferred_date, requested_time: formData.preferred_time, notes: notes.filter(Boolean).join("\n"), special_request: notes.filter(Boolean).join("\n") };
  }, [formData, serviceType]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!validate()) return;
    saveDraft(serviceType, formData);

    if (!canBook) {
      saveServiceIntent(serviceType);
      onClose();
      navigate(needsVerification ? `/verify-email?email=${encodeURIComponent(user?.email || "")}` : "/login");
      return;
    }

    if (serviceType === "hotel") {
      navigate("/customer/hotel");
      return;
    }

    setReviewOpen(true);
  };

  const confirmBooking = async () => {
    const payload = buildPayload();
    try {
      setLoading(true);
      const data = await apiRequest("/customer/requests", { method: "POST", body: JSON.stringify(payload) });
      if (data.success) { clearDraft(); setReviewOpen(false); showSuccess("Booking request submitted successfully. Please wait for receptionist approval."); onClose(); } else { showError(data.message || "Failed to submit request."); }
    } catch (error) {
      const message = error.response?.data?.message || error.response?.data?.error || error.message || "Server error while submitting booking request.";
      showError(message);
    } finally { setLoading(false); }
  };

  const fe = (name) => errors[name] ? <span className="svc-field-error">{errors[name]}</span> : null;

  const renderCommonFields = () => (
    <>
      <div className="svc-form-row">
        <label className="svc-form-group">
          <span><FontAwesomeIcon icon={faUser} /> Customer Name *</span>
          <input type="text" name="customer_name" value={formData.customer_name} onChange={handleChange} placeholder="Your full name" readOnly={isCustomer} className={errors.customer_name ? "has-error" : ""} />
          {fe("customer_name")}
        </label>
        <label className="svc-form-group">
          <span><FontAwesomeIcon icon={faEnvelope} /> Email *</span>
          <input type="email" name="customer_email" value={formData.customer_email} onChange={handleChange} placeholder="you@example.com" readOnly={isCustomer} className={errors.customer_email ? "has-error" : ""} />
          {fe("customer_email")}
        </label>
      </div>
      <div className="svc-form-row">
        {canBook ? (
          <label className="svc-form-group">
            <span><FontAwesomeIcon icon={faPaw} /> Pet *</span>
            <select name="pet_id" value={formData.pet_id} onChange={handleChange} className={errors.pet_id ? "has-error" : ""}>
              <option value="">Select your pet</option>
              {pets.map((pet) => (
                <option key={pet.id} value={pet.id}>
                  {pet.name} — {pet.species || pet.type || "Pet"}{pet.breed ? ` (${pet.breed})` : ""}
                </option>
              ))}
            </select>
            {fe("pet_id")}
            {pets.length === 0 && (
              <span className="svc-field-hint">No registered pets yet — add one under My Pets before booking.</span>
            )}
          </label>
        ) : (
          <>
            <label className="svc-form-group">
              <span><FontAwesomeIcon icon={faPaw} /> Pet Type *</span>
              <select name="pet_type" value={formData.pet_type} onChange={handleChange} className={errors.pet_type ? "has-error" : ""}>
                <option value="">Select pet type</option>
                <option value="Cat">Cat</option>
                <option value="Dog">Dog</option>
              </select>
              {fe("pet_type")}
            </label>
            <label className="svc-form-group">
              <span><FontAwesomeIcon icon={faPaw} /> Pet</span>
              <input type="text" value="Sign in to select your registered pet" disabled readOnly />
            </label>
          </>
        )}
      </div>
    </>
  );

  const renderHotelFields = () => (
    <>
      <div className="svc-form-row">
        <label className="svc-form-group">
          <span><FontAwesomeIcon icon={faCalendarAlt} /> Stay Date *</span>
          <DatePickerInput selected={parseDateOnly(formData.check_in_date)} onChange={(date) => handleDateChange("check_in_date", date)} placeholderText="mm/dd/yyyy" minDate={new Date()} required className={errors.check_in_date ? "has-error" : ""} />
          {fe("check_in_date")}
        </label>
        <label className="svc-form-group">
          <span><FontAwesomeIcon icon={faCalendarAlt} /> Duration</span>
          <input type="text" value="Same-day stay — 10:00 AM to 6:00 PM" disabled readOnly />
        </label>
      </div>
      <div className="svc-form-row">
        <label className="svc-form-group">
          <span><FontAwesomeIcon icon={faClock} /> Preferred Time *</span>
          <select name="preferred_time" value={formData.preferred_time} onChange={handleChange} className={errors.preferred_time ? "has-error" : ""}>
            <option value="">Select time</option>
            {timeSlots.map((slot) => <option key={slot.value} value={slot.value}>{slot.label}</option>)}
          </select>
          {fe("preferred_time")}
        </label>
        <label className="svc-form-group">
          <span><FontAwesomeIcon icon={faBed} /> Room Type</span>
          <select
            name="room_type"
            value={formData.room_type}
            onChange={handleChange}
            disabled={!formData.check_in_date || hotelAvailabilityLoading || availableRoomTypes === null}
            className={errors.room_type ? "has-error" : ""}
          >
            {ROOM_TYPES.map((option) => {
              const available = !option.value || availableRoomTypes?.includes(option.value);
              return <option key={option.value} value={option.value} disabled={!available}>{option.label}{option.value && !available ? " (Unavailable)" : ""}</option>;
            })}
          </select>
          {hotelAvailabilityLoading && <span className="svc-availability-status" role="status">Checking room availability...</span>}
          {!hotelAvailabilityLoading && hotelAvailabilityError && <span className="svc-availability-status" role="alert">{hotelAvailabilityError}</span>}
          {fe("room_type")}
        </label>
      </div>
      <label className="svc-form-group full">
        <span>Special Care Instructions</span>
        <textarea name="special_care_instructions" value={formData.special_care_instructions} onChange={handleChange} rows={3} placeholder="Dietary needs, medication, behavior notes..." />
      </label>
    </>
  );

  const renderGroomingFields = () => (
    <>
      <div className="svc-form-row">
        <label className="svc-form-group">
          <span><FontAwesomeIcon icon={faScissors} /> Grooming Service Type *</span>
          <select name="grooming_service_type" value={formData.grooming_service_type} onChange={handleChange} className={errors.grooming_service_type ? "has-error" : ""}>
            {GROOMING_TYPES.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
          </select>
          {fe("grooming_service_type")}
        </label>
        <label className="svc-form-group">
          <span><FontAwesomeIcon icon={faCalendarAlt} /> Preferred Date *</span>
          <DatePickerInput selected={parseDateOnly(formData.preferred_date)} onChange={(date) => handleDateChange("preferred_date", date)} placeholderText="mm/dd/yyyy" minDate={new Date()} required className={errors.preferred_date ? "has-error" : ""} />
          {fe("preferred_date")}
        </label>
      </div>
      <div className="svc-form-row">
        <label className="svc-form-group">
          <span><FontAwesomeIcon icon={faClock} /> Preferred Time *</span>
          <select name="preferred_time" value={formData.preferred_time} onChange={handleChange} disabled={!formData.preferred_date || !formData.grooming_service_type || availabilityLoading} className={errors.preferred_time ? "has-error" : ""}>
            <option value="">Select an available time</option>
            {availableTimeSlots.map((slot) => <option key={slot.time} value={slot.time} disabled={!slot.available}>{slot.label}{slot.available ? "" : " (Unavailable)"}</option>)}
          </select>
          {availabilityLoading && <span role="status">Checking available times...</span>}
          {fe("preferred_time")}
        </label>
      </div>
      <label className="svc-form-group full">
        <span>Special Grooming Instructions</span>
        <textarea name="special_grooming_instructions" value={formData.special_grooming_instructions} onChange={handleChange} rows={3} placeholder="Sensitive skin, preferred products, style requests..." />
      </label>
    </>
  );

  const renderVetFields = () => (
    <>
      <div className="svc-form-row">
        <label className="svc-form-group">
          <span><FontAwesomeIcon icon={faStethoscope} /> Veterinary Service Type *</span>
          <select name="veterinary_service_type" value={formData.veterinary_service_type} onChange={handleChange} className={errors.veterinary_service_type ? "has-error" : ""}>
            {VET_TYPES.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
          </select>
          {fe("veterinary_service_type")}
        </label>
        <label className="svc-form-group">
          <span><FontAwesomeIcon icon={faCalendarAlt} /> Preferred Date *</span>
          <DatePickerInput selected={parseDateOnly(formData.preferred_date)} onChange={(date) => handleDateChange("preferred_date", date)} placeholderText="mm/dd/yyyy" minDate={new Date()} required className={errors.preferred_date ? "has-error" : ""} />
          {fe("preferred_date")}
        </label>
      </div>
      <div className="svc-form-row">
        <label className="svc-form-group">
          <span><FontAwesomeIcon icon={faClock} /> Preferred Time *</span>
          <select name="preferred_time" value={formData.preferred_time} onChange={handleChange} disabled={!formData.preferred_date || !formData.veterinary_service_type || availabilityLoading} className={errors.preferred_time ? "has-error" : ""}>
            <option value="">Select an available time</option>
            {availableTimeSlots.map((slot) => <option key={slot.time} value={slot.time} disabled={!slot.available}>{slot.label}{slot.available ? "" : " (Unavailable)"}</option>)}
          </select>
          {availabilityLoading && <span role="status">Checking available times...</span>}
          {fe("preferred_time")}
        </label>
      </div>
      <label className="svc-form-group full">
        <span>Main Reason for Visit *</span>
        <textarea name="main_reason_for_visit" value={formData.main_reason_for_visit} onChange={handleChange} rows={3} placeholder="Describe symptoms, concerns, or the reason for the visit..." className={errors.main_reason_for_visit ? "has-error" : ""} />
        {fe("main_reason_for_visit")}
      </label>
      {!showHealthInfo && (
        <button type="button" className="svc-add-health-btn" onClick={() => setShowHealthInfo(true)}>
          <FontAwesomeIcon icon={faPlusCircle} /> Add Additional Health Information
        </button>
      )}
      {showHealthInfo && (
        <div className="svc-health-section">
          <div className="svc-health-header">
            <h4><FontAwesomeIcon icon={faHeartbeat} /> Additional Health Information</h4>
            <button type="button" className="svc-health-cancel" onClick={() => { setShowHealthInfo(false); setFormData((prev) => ({ ...prev, flu_symptoms: "", observed_issues: "", appetite_condition: "", energy_level: "", symptom_duration: "", medications_taken: "", recent_exposure: "", urgency_level: "" })); }}>
              <FontAwesomeIcon icon={faTimesCircle} /> Cancel
            </button>
          </div>
          <div className="svc-form-row">
            <label className="svc-form-group"><span>Flu-like Symptoms</span><input type="text" name="flu_symptoms" value={formData.flu_symptoms} onChange={handleChange} placeholder="e.g., sneezing, coughing..." /></label>
            <label className="svc-form-group"><span>Symptoms or Observed Issues</span><input type="text" name="observed_issues" value={formData.observed_issues} onChange={handleChange} placeholder="e.g., limping, scratching..." /></label>
          </div>
          <div className="svc-form-row">
            <label className="svc-form-group"><span>Appetite Condition</span><select name="appetite_condition" value={formData.appetite_condition} onChange={handleChange}>{APPETITE_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}</select></label>
            <label className="svc-form-group"><span>Energy Level</span><select name="energy_level" value={formData.energy_level} onChange={handleChange}>{ENERGY_LEVELS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}</select></label>
          </div>
          <div className="svc-form-row">
            <label className="svc-form-group"><span>Symptom Duration</span><input type="text" name="symptom_duration" value={formData.symptom_duration} onChange={handleChange} placeholder="e.g., 2 days, 1 week..." /></label>
            <label className="svc-form-group"><span>Medication or Vitamins Taken</span><input type="text" name="medications_taken" value={formData.medications_taken} onChange={handleChange} placeholder="List any current medications..." /></label>
          </div>
          <div className="svc-form-row">
            <label className="svc-form-group"><span>Recent Exposure or Possible Cause</span><input type="text" name="recent_exposure" value={formData.recent_exposure} onChange={handleChange} placeholder="e.g., new food, other sick pet..." /></label>
            <label className="svc-form-group"><span>Urgency Level</span><select name="urgency_level" value={formData.urgency_level} onChange={handleChange}>{URGENCY_LEVELS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}</select></label>
          </div>
        </div>
      )}
    </>
  );

  return (
    <div className="hbk-overlay" onClick={onClose}>
      <div className={`hbk-modal ${config.accent}`} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="service-modal-title">
        <div className="hbk-head">
          <div>
            <span className="hbk-eyebrow">
              <FontAwesomeIcon icon={config.icon} />
              Service Booking
            </span>
            <h2 id="service-modal-title">{config.title}</h2>
            <p className="svc-subtitle">Fill in the details and we will handle the rest.</p>
          </div>
          <button type="button" className="close-btn" onClick={onClose} aria-label="Close">
            <FontAwesomeIcon icon={faTimes} />
          </button>
        </div>
        <form className="hbk-body svc-form" onSubmit={handleSubmit} noValidate>
          {renderCommonFields()}
          {serviceType === "hotel" && renderHotelFields()}
          {serviceType === "grooming" && renderGroomingFields()}
          {serviceType === "vet" && renderVetFields()}
          <div className="hbk-foot">
            <button type="submit" className="svc-submit-btn" disabled={loading || availabilityLoading || hotelAvailabilityLoading}>
              <FontAwesomeIcon icon={faPaperPlane} /> {loading ? "Submitting..." : "Submit Booking Request"}
            </button>
          </div>
        </form>
      </div>

      <BookingReviewModal
        open={reviewOpen}
        onClose={() => setReviewOpen(false)}
        onConfirm={confirmBooking}
        loading={loading}
        badge={config.title}
        pet={(() => {
          const p = pets.find((pet) => String(pet.id) === String(formData.pet_id));
          return p ? { name: p.name, species: p.species || p.type, breed: p.breed } : null;
        })()}
        details={[
          { label: "Service", value: serviceType === "grooming" ? formData.grooming_service_type : formData.veterinary_service_type },
          { label: "Date", value: formData.preferred_date && new Date(`${formData.preferred_date}T00:00:00`).toLocaleDateString("en-PH", { weekday: "short", month: "short", day: "numeric", year: "numeric" }) },
          { label: "Time", value: formData.preferred_time },
        ]}
        notes={
          serviceType === "grooming"
            ? formData.special_grooming_instructions
            : [
                formData.main_reason_for_visit,
                formData.flu_symptoms && `Flu-like symptoms: ${formData.flu_symptoms}`,
                formData.observed_issues && `Observed issues: ${formData.observed_issues}`,
                formData.appetite_condition && `Appetite: ${formData.appetite_condition}`,
                formData.energy_level && `Energy: ${formData.energy_level}`,
                formData.symptom_duration && `Duration: ${formData.symptom_duration}`,
                formData.medications_taken && `Medications: ${formData.medications_taken}`,
                formData.recent_exposure && `Recent exposure: ${formData.recent_exposure}`,
                formData.urgency_level && `Urgency: ${formData.urgency_level}`,
              ].filter(Boolean).join("\n")
        }
      />
    </div>
  );
};

export default ServiceBookingModal;
