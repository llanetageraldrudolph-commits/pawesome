import React, { useEffect, useMemo, useState, useRef } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import DatePickerInput from "../../components/shared/DatePickerInput";
import { CANCEL_REJECT_REASONS } from "../../utils/alert.jsx";
import {
  faBan,
  faCalendarAlt,
  faCalendarCheck,
  faCheck,
  faClock,
  faCut,
  faDownload,
  faEye,
  faFilter,
  faHistory,
  faHotel,
  faInfoCircle,
  faMoneyBillWave,
  faPaw,
  faPlus,
  faRefresh,
  faSearch,
  faSpinner,
  faStethoscope,
  faTimes,
  faUser,
  faWrench,
} from "@fortawesome/free-solid-svg-icons";
import "../../styles/bookingModal.css";
import "./ReceptionistBookings.css";
import { apiRequest } from "../../api/client";
import { formatDateOnly, parseDateOnly } from "../../utils/date";
import RowActionPopover from "../shared/RowActionPopover";
import { exportToCSV, exportToPDF, exportToExcel } from "../../utils/reportExport";
import ServiceManagerModal from "./ServiceManagerModal";

const initialBookingForm = {
  customerId: "",
  petId: "",
  ownerName: "",
  petName: "",
  petType: "",
  breed: "",
  appointmentDate: "",
  appointmentTime: "10:00",
  service: "",
  duration: "1 day",
  roomType: "Standard Room",
  symptoms: "",
  medicalNotes: "",
  specialRequests: "",
  bookingType: "hotel",
  paymentMethod: "cash",
  paymentStatus: "pending",
  paidAmount: "0",
};

const STATUS_TABS = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "confirmed", label: "Approved" },
  { value: "cancel_requested", label: "Cancel Requests" },
  { value: "reschedule_requested", label: "Reschedule" },
  { value: "cancelled", label: "Cancelled" },
  { value: "rejected", label: "Rejected" },
];

const TYPE_OPTIONS = [
  { value: "all", label: "All Types" },
  { value: "hotel", label: "Hotel" },
  { value: "vet", label: "Veterinary" },
  { value: "grooming", label: "Grooming" },
];

const PAYMENT_OPTIONS = [
  { value: "all", label: "All Payments" },
  { value: "paid", label: "Paid" },
  { value: "partial", label: "Partial" },
  { value: "pending", label: "Pending" },
  { value: "unpaid", label: "Unpaid" },
];

const roomRates = {
  "Standard Room": 50,
  "Deluxe Suite": 80,
  "Presidential Suite": 120,
};

const safeArray = (data, key) => {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.[key])) return data[key];
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.data?.[key])) return data.data[key];
  if (Array.isArray(data?.records)) return data.records;
  if (Array.isArray(data?.items)) return data.items;
  return [];
};

const formatCurrency = (value) => {
  const amount = Number(value || 0);

  return new Intl.NumberFormat("en-PH", {
    style: "currency",
    currency: "PHP",
    minimumFractionDigits: 2,
  }).format(amount);
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

const formatDateTime = (value) => {
  if (!value) return "N/A";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return date.toLocaleString("en-PH", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
  });
};

const formatTime = (value) => {
  if (!value) return "N/A";

  if (String(value).includes("AM") || String(value).includes("PM")) {
    return value;
  }

  if (String(value).includes("T")) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date.toLocaleTimeString("en-PH", {
        hour: "numeric",
        minute: "2-digit",
      });
    }
  }

  const [hour, minute] = String(value).split(":");
  if (!hour || !minute) return value;

  const date = new Date();
  date.setHours(Number(hour), Number(minute), 0, 0);

  return date.toLocaleTimeString("en-PH", {
    hour: "numeric",
    minute: "2-digit",
  });
};

const combineDateTime = (date, time) => {
  if (!date) return "";
  const safeTime = time || "10:00";
  return `${date}T${safeTime}:00`;
};

const getDateFromDateTime = (value) => {
  if (!value) return "";

  if (String(value).includes("T")) {
    return String(value).split("T")[0];
  }

  return value;
};

const getTimeFromDateTime = (value) => {
  if (!value) return "";

  if (String(value).includes("T")) {
    return String(value).split("T")[1]?.slice(0, 5) || "";
  }

  return value;
};

const parseDurationDays = (duration) => {
  if (!duration) return 1;
  if (duration === "1 week") return 7;

  const number = parseInt(duration, 10);
  return Number.isNaN(number) ? 1 : number;
};

const normalizeStatus = (status) => {
  const value = String(status || "pending").toLowerCase();

  if (value === "approved" || value === "scheduled") return "confirmed";
  if (value === "canceled") return "cancelled";

  return value;
};

const normalizePaymentStatus = (status) => {
  const value = String(status || "pending").toLowerCase();

  if (value === "verified" || value === "completed") return "paid";
  if (value === "for_payment" || value === "for payment") return "pending";

  return value;
};

const ReceptionistBookings = () => {
  const [showNewBookingModal, setShowNewBookingModal] = useState(false);
  const [showServiceManager, setShowServiceManager] = useState(false);

  const [showActionModal, setShowActionModal] = useState(false);
  const [selectedBooking, setSelectedBooking] = useState(null);
  const [actionType, setActionType] = useState(null);
  const [actionNote, setActionNote] = useState("");
  const [newDate, setNewDate] = useState("");

  const [availability, setAvailability] = useState(null);
  const [checkingAvailability, setCheckingAvailability] = useState(false);

  const [showCancelModal, setShowCancelModal] = useState(false);
  const [selectedCancelBooking, setSelectedCancelBooking] = useState(null);
  const [cancelAction, setCancelAction] = useState(null);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelNote, setCancelNote] = useState("");

  const [showRescheduleModal, setShowRescheduleModal] = useState(false);
  const [selectedRescheduleBooking, setSelectedRescheduleBooking] = useState(null);
  const [rescheduleAction, setRescheduleAction] = useState(null);
  const [rescheduleNote, setRescheduleNote] = useState("");
  const [rescheduleNewDate, setRescheduleNewDate] = useState("");

  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const [selectedHistoryBooking, setSelectedHistoryBooking] = useState(null);
  const [bookingHistory, setBookingHistory] = useState([]);

  const [showDetailsModal, setShowDetailsModal] = useState(false);
  const [selectedDetailsBooking, setSelectedDetailsBooking] = useState(null);

  const [bookings, setBookings] = useState([]);
  const [services, setServices] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [pets, setPets] = useState([]);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [processing, setProcessing] = useState(false);

  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [lastUpdated, setLastUpdated] = useState("");

  const [filter, setFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [paymentFilter, setPaymentFilter] = useState("all");
  const [searchTerm, setSearchTerm] = useState("");

  const [bookingFormData, setBookingFormData] = useState(initialBookingForm);

  const [showExportDropdown, setShowExportDropdown] = useState(false);

  const successTimerRef = useRef(null);
  const errorTimerRef = useRef(null);

  useEffect(() => {
    return () => {
      if (successTimerRef.current) clearTimeout(successTimerRef.current);
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    };
  }, []);

  const notify = (type, message) => {
    if (type === "success") {
      setSuccess(message);
      if (successTimerRef.current) clearTimeout(successTimerRef.current);
      successTimerRef.current = setTimeout(
        () => setSuccess(""),
        3000
      );
      return;
    }

    setError(message);
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    errorTimerRef.current = setTimeout(() => setError(""), 5000);
  };

  const fetchCustomersAndPets = async () => {
    try {
      const [customersData, petsData] = await Promise.all([
        apiRequest("/customers"),
        apiRequest("/pets"),
      ]);

      setCustomers(safeArray(customersData, "customers"));
      setPets(safeArray(petsData, "pets"));
    } catch {
      setCustomers([]);
      setPets([]);
    }
  };

  const fetchServices = async () => {
    try {
      const data = await apiRequest("/services");
      setServices(safeArray(data, "services"));
    } catch {
      setServices([]);
    }
  };

  const fetchBookings = async ({ silent = false } = {}) => {
    try {
      if (silent) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }

      setError("");

      const [appointmentsData, boardingsData, groomingData] = await Promise.all([
        apiRequest("/receptionist/appointment/list").catch(() => null),
        apiRequest("/receptionist/boarding-requests").catch(() => null),
        apiRequest("/grooming").catch(() => null),
      ]);

      const allBookings = [];

      safeArray(appointmentsData, "appointments").forEach((booking) => {
        const scheduledAt =
          booking.scheduled_at ||
          booking.appointment_date ||
          booking.date ||
          booking.booking_date ||
          "";

        allBookings.push({
          id: booking.id,
          customerId: booking.customer_id || booking.customer?.id || booking.user_id,
          type: "vet",
          petName: booking.pet?.name || booking.pet_name || "Pet",
          petType: booking.pet?.species || booking.pet?.type || "Pet",
          breed: booking.pet?.breed || "",
          owner: booking.customer?.name || booking.customer_name || "Customer",
          ownerPhone: booking.customer?.phone || booking.customer_phone || "",
          service: booking.service?.name || booking.service_name || booking.service || "Veterinary Service",
          appointmentDate: getDateFromDateTime(scheduledAt),
          appointmentTime: booking.appointment_time || getTimeFromDateTime(booking.scheduled_at),
          status: normalizeStatus(booking.status),
          amount: booking.price || booking.amount || booking.total_amount || 0,
          paidAmount: booking.paid_amount || 0,
          paymentStatus: normalizePaymentStatus(booking.payment_status),
          symptoms: booking.symptoms || "",
          medicalNotes: booking.medical_notes || "",
          createdAt: booking.created_at || scheduledAt || new Date().toISOString(),
          raw: booking,
        });
      });

      safeArray(boardingsData, "boardings").forEach((boarding) => {
        allBookings.push({
          id: boarding.id,
          customerId: boarding.customer_id || boarding.customer?.id || boarding.user_id,
          type: "hotel",
          petName: boarding.pet?.name || boarding.pet_name || "Pet",
          petType: boarding.pet?.species || boarding.pet?.type || "Pet",
          breed: boarding.pet?.breed || "",
          owner: boarding.customer?.name || boarding.customer_name || "Customer",
          ownerPhone: boarding.customer?.phone || boarding.customer_phone || "",
          roomType: boarding.room_type || boarding.hotel_room?.name || boarding.hotel_room_id || "Room",
          checkIn: boarding.check_in || "",
          checkOut: boarding.check_out || "",
          service: boarding.service_name || "Hotel Stay",
          appointmentDate: boarding.check_in || "",
          appointmentTime: "",
          status: normalizeStatus(boarding.status),
          amount: boarding.total_amount || boarding.amount || 0,
          paidAmount: boarding.paid_amount || 0,
          paymentStatus: normalizePaymentStatus(boarding.payment_status || "pending"),
          createdAt: boarding.created_at || boarding.check_in || new Date().toISOString(),
          raw: boarding,
        });
      });

      safeArray(groomingData, "groomings").forEach((grooming) => {
        const scheduledAt =
          grooming.scheduled_at ||
          grooming.appointment_date ||
          grooming.date ||
          grooming.booking_date ||
          "";

        allBookings.push({
          id: grooming.id,
          customerId: grooming.customer_id || grooming.customer?.id || grooming.user_id,
          type: "grooming",
          petName: grooming.pet?.name || grooming.pet_name || "Pet",
          petType: grooming.pet?.species || grooming.pet?.type || "Pet",
          breed: grooming.pet?.breed || "",
          owner: grooming.customer?.name || grooming.customer_name || "Customer",
          ownerPhone: grooming.customer?.phone || grooming.customer_phone || "",
          service: grooming.service?.name || grooming.service_name || grooming.service || "Grooming",
          appointmentDate: getDateFromDateTime(scheduledAt),
          appointmentTime: grooming.appointment_time || getTimeFromDateTime(grooming.scheduled_at),
          status: normalizeStatus(grooming.status),
          amount: grooming.amount || grooming.price || grooming.total_amount || 0,
          paidAmount: grooming.paid_amount || 0,
          paymentStatus: normalizePaymentStatus(grooming.payment_status || "unpaid"),
          specialRequests: grooming.special_requests || grooming.notes || "",
          createdAt: grooming.created_at || scheduledAt || new Date().toISOString(),
          raw: grooming,
        });
      });

      allBookings.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

      setBookings(allBookings);
      setLastUpdated(new Date().toLocaleString("en-PH"));
    } catch (err) {
      notify("error", err.message || "Failed to load bookings.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchBookings();
    fetchServices();
    fetchCustomersAndPets();

    const intervalId = setInterval(() => fetchBookings({ silent: true }), 30000);

    return () => clearInterval(intervalId);
  }, []);

  const handleCustomerChange = (customerId) => {
    const customer = customers.find((item) => String(item.id) === String(customerId));

    if (customer) {
      setBookingFormData((prev) => ({
        ...prev,
        customerId,
        petId: "",
        ownerName: customer.name || customer.full_name || "Customer",
        petName: "",
        petType: "",
        breed: "",
      }));
    }
  };

  const handlePetChange = (petId) => {
    const pet = pets.find((item) => String(item.id) === String(petId));

    if (pet) {
      setBookingFormData((prev) => ({
        ...prev,
        petId,
        petName: pet.name || "",
        petType: pet.type || pet.species || "",
        breed: pet.breed || "",
      }));
    }
  };

  const getAvailablePets = () => {
    if (!bookingFormData.customerId) return [];

    return pets.filter(
      (pet) =>
        String(pet.customer_id || pet.customerId || pet.owner_id || pet.user_id) ===
        String(bookingFormData.customerId)
    );
  };

  const handleBookingInputChange = (event) => {
    const { name, value } = event.target;

    setBookingFormData((prev) => {
      if (name === "bookingType") {
        return {
          ...prev,
          bookingType: value,
          service: value === "hotel" ? "Pet Hotel Stay" : "",
          symptoms: "",
          medicalNotes: "",
          specialRequests: "",
        };
      }

      return {
        ...prev,
        [name]: value,
      };
    });
  };

  const vetServices = useMemo(() => {
    return services.filter((service) => {
      const category = String(service.category || "").toLowerCase();
      return !category.includes("groom") && !category.includes("boarding") && !category.includes("hotel");
    });
  }, [services]);

  const groomingServices = useMemo(() => {
    return services.filter((service) =>
      String(service.category || "").toLowerCase().includes("groom")
    );
  }, [services]);

  const selectedService = useMemo(() => {
    return services.find(
      (service) =>
        String(service.id) === String(bookingFormData.service) ||
        String(service.name) === String(bookingFormData.service)
    );
  }, [services, bookingFormData.service]);

  const calculatedAmount = useMemo(() => {
    if (bookingFormData.bookingType === "hotel") {
      const dailyRate = roomRates[bookingFormData.roomType] || roomRates["Standard Room"];
      return dailyRate * parseDurationDays(bookingFormData.duration);
    }

    if (selectedService) {
      return Number(selectedService.price || 0);
    }

    return 0;
  }, [
    bookingFormData.bookingType,
    bookingFormData.roomType,
    bookingFormData.duration,
    selectedService,
  ]);

  const getPaymentStatusFromAmount = (amount, paidAmount) => {
    const paid = Number(paidAmount || 0);

    if (paid >= Number(amount || 0) && Number(amount || 0) > 0) return "paid";
    if (paid > 0) return "partial";

    return "pending";
  };

  const handleBookingSubmit = async (event) => {
    event.preventDefault();

    if (!bookingFormData.customerId || !bookingFormData.petId || !bookingFormData.appointmentDate) {
      notify("error", "Please select a customer, pet, and appointment date.");
      return;
    }

    if (bookingFormData.bookingType !== "hotel" && !bookingFormData.service) {
      notify("error", "Please select a service.");
      return;
    }

    try {
      setProcessing(true);

      const amount = calculatedAmount;
      const paidAmount = Number(bookingFormData.paidAmount || 0);
      const paymentStatus = getPaymentStatusFromAmount(amount, paidAmount);

      let endpoint = "";
      let payload = {};

      if (bookingFormData.bookingType === "hotel") {
        endpoint = "/boardings";
        payload = {
          pet_id: bookingFormData.petId,
          customer_id: bookingFormData.customerId,
          hotel_room_id: bookingFormData.roomType,
          room_type: bookingFormData.roomType,
          check_in: bookingFormData.appointmentDate,
          check_out: bookingFormData.appointmentDate,
          total_amount: amount,
          payment_status: paymentStatus,
          paid_amount: paidAmount,
          payment_method: bookingFormData.paymentMethod,
          notes: bookingFormData.specialRequests,
        };
      }

      if (bookingFormData.bookingType === "vet") {
        endpoint = "/receptionist/appointments";
        payload = {
          pet_id: bookingFormData.petId,
          customer_id: bookingFormData.customerId,
          service_id: bookingFormData.service,
          scheduled_at: combineDateTime(
            bookingFormData.appointmentDate,
            bookingFormData.appointmentTime
          ),
          price: amount,
          payment_status: paymentStatus,
          paid_amount: paidAmount,
          payment_method: bookingFormData.paymentMethod,
          symptoms: bookingFormData.symptoms,
          medical_notes: bookingFormData.medicalNotes,
          notes: bookingFormData.specialRequests,
        };
      }

      if (bookingFormData.bookingType === "grooming") {
        endpoint = "/grooming";
        payload = {
          pet_id: bookingFormData.petId,
          customer_id: bookingFormData.customerId,
          service_id: bookingFormData.service,
          scheduled_at: combineDateTime(
            bookingFormData.appointmentDate,
            bookingFormData.appointmentTime
          ),
          price: amount,
          payment_status: paymentStatus,
          paid_amount: paidAmount,
          payment_method: bookingFormData.paymentMethod,
          special_requests: bookingFormData.specialRequests,
        };
      }

      await apiRequest(endpoint, {
        method: "POST",
        body: JSON.stringify(payload),
      });

      notify("success", "Walk-in booking created successfully.");
      handleBookingCancel();
      await fetchBookings({ silent: true });
    } catch (err) {
      notify("error", err.message || "Failed to create booking. Please try again.");
    } finally {
      setProcessing(false);
    }
  };

  const handleBookingCancel = () => {
    setBookingFormData(initialBookingForm);
    setShowNewBookingModal(false);
  };

  const checkAvailability = async (booking, newDateValue = null) => {
    setCheckingAvailability(true);
    setAvailability(null);

    try {
      const targetDate = newDateValue || booking.appointmentDate || booking.checkIn;

      let endpoint = "";

      if (booking.type === "hotel") {
        // For hotel bookings, we need pet_id and species
        const petId = booking.raw?.pet_id || booking.petId;
        const species = booking.petType?.toLowerCase() || booking.raw?.pet?.species?.toLowerCase();
        endpoint = `/boarding/rooms/available?check_in_date=${targetDate}&check_out_date=${targetDate}&pet_id=${petId}&species=${species}`;
      } else if (booking.type === "vet") {
        endpoint = `/receptionist/appointment/list?from_date=${targetDate}&to_date=${targetDate}`;
      } else if (booking.type === "grooming") {
        endpoint = "/grooming";
      }

      const data = await apiRequest(endpoint);

      setAvailability({
        available: data?.success !== false,
        message: data?.message || "Availability route is reachable.",
        details: data,
      });
    } catch (err) {
      setAvailability({
        available: false,
        message: err.message || "Unable to verify availability. Please refresh and try again.",
        details: null,
      });
    } finally {
      setCheckingAvailability(false);
    }
  };

  const openActionModal = (booking, type) => {
    setSelectedBooking(booking);
    setActionType(type);
    setActionNote("");
    setNewDate("");
    setAvailability(null);
    setShowActionModal(true);

    if (type === "approve" || type === "reschedule") {
      checkAvailability(booking);
    }
  };

  const closeActionModal = () => {
    setShowActionModal(false);
    setSelectedBooking(null);
    setActionType(null);
    setActionNote("");
    setNewDate("");
    setAvailability(null);
  };

  const handleActionSubmit = async () => {
    if (!selectedBooking) return;

    if (actionType === "reschedule" && !newDate) {
      notify("error", "Please select a new date.");
      return;
    }

    if (actionType === "reject" && !actionNote.trim()) {
      notify("error", "Please provide a reason for rejection.");
      return;
    }

    if (
      (actionType === "approve" || actionType === "reschedule") &&
      availability?.available === false
    ) {
      notify("error", "Selected schedule is not available.");
      return;
    }

    try {
      setProcessing(true);

      let endpoint = "";
      let method = "POST";
      let payload = {};

      if (selectedBooking.type === "hotel") {
        if (actionType === "approve") {
          endpoint = `/receptionist/boarding-requests/${selectedBooking.id}/approve`;
          method = "POST";
          payload = { notes: actionNote };
        }

        if (actionType === "reject") {
          endpoint = `/receptionist/boarding-requests/${selectedBooking.id}/reject`;
          method = "POST";
          payload = { rejection_reason: actionNote };
        }

        if (actionType === "reschedule") {
          endpoint = `/receptionist/boarding-requests/${selectedBooking.id}/schedule`;
          method = "POST";
          payload = {
            check_in: newDate,
            check_out: newDate,
            notes: actionNote,
          };
        }
      } else if (selectedBooking.type === "grooming") {
        endpoint = `/grooming/${selectedBooking.id}/status`;
        method = "PUT";

        payload = {
          status:
            actionType === "approve"
              ? "approved"
              : actionType === "reject"
              ? "rejected"
              : "pending",
          ...(actionType === "reject" ? { reason: actionNote } : {}),
          scheduled_at:
            actionType === "reschedule"
              ? combineDateTime(newDate, selectedBooking.appointmentTime || "10:00")
              : undefined,
          notes: actionNote,
        };
      } else {
        if (actionType === "approve") {
          endpoint = `/appointments/${selectedBooking.id}/status`;
          method = "PATCH";
          payload = { status: "scheduled", notes: actionNote };
        }

        if (actionType === "reject") {
          endpoint = `/receptionist/appointments/${selectedBooking.id}/reject`;
          method = "POST";
          payload = { reason: actionNote };
        }

        if (actionType === "reschedule") {
          endpoint = `/receptionist/appointments/${selectedBooking.id}/reschedule`;
          method = "POST";
          payload = {
            scheduled_at: combineDateTime(
              newDate,
              selectedBooking.appointmentTime || "10:00"
            ),
            notes: actionNote,
          };
        }
      }

      await apiRequest(endpoint, {
        method,
        body: JSON.stringify(payload),
      });

      notify("success", `Booking ${actionType}d successfully.`);
      closeActionModal();
      await fetchBookings({ silent: true });
    } catch (err) {
      notify("error", err.message || "Failed to update booking.");
    } finally {
      setProcessing(false);
    }
  };

  const openCancelModal = (booking, action) => {
    setSelectedCancelBooking(booking);
    setCancelAction(action);
    setCancelNote("");
    setShowCancelModal(true);
  };

  const closeCancelModal = () => {
    setShowCancelModal(false);
    setSelectedCancelBooking(null);
    setCancelAction(null);
    setCancelReason("");
    setCancelNote("");
  };

  const handleCancelSubmit = async () => {
    if (!selectedCancelBooking) return;

    const rejectReason =
      cancelAction === "reject"
        ? cancelReason === "__other__"
          ? cancelNote.trim()
          : cancelReason
        : "";

    if (cancelAction === "reject" && !rejectReason) {
      notify("error", "Please provide a reason for rejecting this cancel request.");
      return;
    }

    try {
      setProcessing(true);

      const endpoint =
        selectedCancelBooking.type === "hotel"
          ? `/receptionist/boarding-requests/${selectedCancelBooking.id}/reject`
          : `/receptionist/appointments/${selectedCancelBooking.id}/cancel`;

      await apiRequest(endpoint, {
        method: "POST",
        body: JSON.stringify({
          action: cancelAction,
          note: cancelNote,
          reason:
            cancelAction === "reject"
              ? rejectReason
              : cancelNote || "Cancellation approved by receptionist",
          rejection_reason:
            cancelAction === "reject"
              ? rejectReason
              : cancelNote || "Cancellation approved by receptionist",
        }),
      });

      notify(
        "success",
        `Cancel request ${cancelAction === "approve" ? "approved" : "rejected"} successfully.`
      );

      closeCancelModal();
      await fetchBookings({ silent: true });
    } catch (err) {
      notify("error", err.message || "Failed to update cancel request.");
    } finally {
      setProcessing(false);
    }
  };

  const openRescheduleModal = (booking, action) => {
    setSelectedRescheduleBooking(booking);
    setRescheduleAction(action);
    setRescheduleNote("");
    setRescheduleNewDate("");
    setShowRescheduleModal(true);
  };

  const closeRescheduleModal = () => {
    setShowRescheduleModal(false);
    setSelectedRescheduleBooking(null);
    setRescheduleAction(null);
    setRescheduleNote("");
    setRescheduleNewDate("");
  };

  const handleRescheduleSubmit = async () => {
    if (!selectedRescheduleBooking) return;

    if (rescheduleAction === "approve" && !rescheduleNewDate) {
      notify("error", "Please select the approved new date.");
      return;
    }

    if (rescheduleAction === "reject" && !rescheduleNote.trim()) {
      notify("error", "Please provide a reason for rejecting this reschedule request.");
      return;
    }

    try {
      setProcessing(true);

      let endpoint = `/receptionist/appointments/${selectedRescheduleBooking.id}/reschedule`;
      let method = "POST";
      let payload = {
        action: rescheduleAction,
        scheduled_at:
          rescheduleAction === "approve"
            ? combineDateTime(
                rescheduleNewDate,
                selectedRescheduleBooking.appointmentTime || "10:00"
              )
            : null,
        reason: rescheduleNote,
      };

      if (selectedRescheduleBooking.type === "hotel") {
        endpoint = `/boardings/${selectedRescheduleBooking.id}`;
        method = "PUT";
        payload =
          rescheduleAction === "approve"
            ? {
                check_in: rescheduleNewDate,
                check_out: rescheduleNewDate,
                notes: rescheduleNote,
              }
            : {
                status: "confirmed",
                notes: rescheduleNote,
              };
      }

      await apiRequest(endpoint, {
        method,
        body: JSON.stringify(payload),
      });

      notify(
        "success",
        `Reschedule request ${
          rescheduleAction === "approve" ? "approved" : "rejected"
        } successfully.`
      );

      closeRescheduleModal();
      await fetchBookings({ silent: true });
    } catch (err) {
      // Handle specific double booking conflict errors
      if (err.message?.includes('already has an appointment at the selected date and time')) {
        notify("error", "This veterinarian already has an appointment at the selected date and time.");
      } else if (err.message?.includes('already reserved')) {
        notify("error", "This grooming slot is already reserved.");
      } else if (err.message?.includes('already booked for the selected date range')) {
        notify("error", "This room/kennel is already booked for the selected date range.");
      } else {
        notify("error", err.message || "Failed to update reschedule request.");
      }
    } finally {
      setProcessing(false);
    }
  };

  const openHistoryModal = async (booking) => {
    setSelectedHistoryBooking(booking);
    setShowHistoryModal(true);
    setBookingHistory([]);

    try {
      const endpoint =
        booking.type === "hotel"
          ? `/boardings/${booking.id}`
          : `/receptionist/appointments/${booking.id}`;

      const data = await apiRequest(endpoint);
      setBookingHistory(safeArray(data?.history || data?.data?.history || [], "history"));
    } catch {
      setBookingHistory([]);
    }
  };

  const closeHistoryModal = () => {
    setShowHistoryModal(false);
    setSelectedHistoryBooking(null);
    setBookingHistory([]);
  };

  const openDetailsModal = (booking) => {
    setSelectedDetailsBooking(booking);
    setShowDetailsModal(true);
  };

  const closeDetailsModal = () => {
    setSelectedDetailsBooking(null);
    setShowDetailsModal(false);
  };

  const filteredBookings = useMemo(() => {
    const keyword = searchTerm.trim().toLowerCase();

    return bookings.filter((booking) => {
      const matchesStatus = filter === "all" || booking.status === filter;
      const matchesType = typeFilter === "all" || booking.type === typeFilter;
      const matchesPayment =
        paymentFilter === "all" || booking.paymentStatus === paymentFilter;

      const searchableText = [
        booking.id,
        booking.petName,
        booking.owner,
        booking.service,
        booking.type,
        booking.status,
        booking.paymentStatus,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      const matchesSearch = !keyword || searchableText.includes(keyword);

      return matchesStatus && matchesType && matchesPayment && matchesSearch;
    });
  }, [bookings, filter, typeFilter, paymentFilter, searchTerm]);

  const stats = useMemo(() => {
    return {
      total: bookings.length,
      pending: bookings.filter((item) => item.status === "pending").length,
      approved: bookings.filter(
        (item) => item.status === "confirmed" || item.status === "approved"
      ).length,
      cancelRequests: bookings.filter((item) => item.status === "cancel_requested").length,
      rescheduleRequests: bookings.filter(
        (item) => item.status === "reschedule_requested"
      ).length,
      pendingPayments: bookings.filter(
        (item) => item.paymentStatus === "pending" || item.paymentStatus === "unpaid"
      ).length,
    };
  }, [bookings]);

  const exportColumns = [
    { key: "id", label: "Booking ID" },
    { key: "type", label: "Type" },
    { key: "petName", label: "Pet" },
    { key: "owner", label: "Owner" },
    { key: "service", label: "Service" },
    { key: "date", label: "Date" },
    { key: "time", label: "Time" },
    { key: "paymentStatus", label: "Payment" },
    { key: "status", label: "Status" },
    { key: "amount", label: "Amount" },
  ];

  const handleExport = (format) => {
    setShowExportDropdown(false);
    if (filteredBookings.length === 0) {
      notify("error", "No bookings to export.");
      return;
    }

    const exportData = filteredBookings.map((booking) => ({
      ...booking,
      date: formatDate(booking.appointmentDate || booking.checkIn),
      time: formatTime(booking.appointmentTime),
    }));

    const filename = "receptionist-bookings";
    if (format === "csv") exportToCSV(exportData, exportColumns, filename);
    else if (format === "excel") exportToExcel(exportData, exportColumns, filename);
    else if (format === "pdf") exportToPDF(exportData, exportColumns, "Receptionist Bookings", filename);

    notify("success", "Bookings exported successfully.");
  };

  const clearFilters = () => {
    setFilter("all");
    setTypeFilter("all");
    setPaymentFilter("all");
    setSearchTerm("");
  };

  const getTypeIcon = (type) => {
    if (type === "hotel") return faHotel;
    if (type === "vet") return faStethoscope;
    if (type === "grooming") return faCut;
    return faPaw;
  };

  const getTypeLabel = (type) => {
    if (type === "hotel") return "Hotel";
    if (type === "vet") return "Vet";
    if (type === "grooming") return "Grooming";
    return "Service";
  };

  return (
    <div className="receptionist-bookings">
      {success && (
        <div className="rb-toast success">
          <FontAwesomeIcon icon={faCheck} />
          <span>{success}</span>
        </div>
      )}

      {error && (
        <div className="rb-toast error">
          <FontAwesomeIcon icon={faBan} />
          <span>{error}</span>
        </div>
      )}

      <section className="booking-hero">
        <div>
          <span className="rb-eyebrow">
            <FontAwesomeIcon icon={faCalendarCheck} />
            Front Desk Booking Center
          </span>

          <h1>Booking Management</h1>

          <p>
            Manage walk-in bookings, review pending requests, handle cancellation and
            reschedule requests, and monitor booking history from one workspace.
          </p>

          <small>Last updated: {lastUpdated || "Not refreshed yet"}</small>
        </div>

        <div className="booking-hero-actions">
          <button
            type="button"
            className="secondary-btn"
            onClick={() => setShowServiceManager(true)}
          >
            <FontAwesomeIcon icon={faWrench} />
            Manage Services
          </button>

          <button
            type="button"
            className={`secondary-btn ${refreshing ? "loading" : ""}`}
            onClick={() => fetchBookings({ silent: true })}
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

          <button
            type="button"
            className="primary-btn create-btn"
            onClick={() => setShowNewBookingModal(true)}
          >
            <FontAwesomeIcon icon={faPlus} />
            Create Booking
          </button>
        </div>
      </section>

      {showServiceManager && (
        <ServiceManagerModal onClose={() => setShowServiceManager(false)} />
      )}

      <section className="dashboard-summary">
        <button type="button" className="summary-card" onClick={() => setFilter("pending")}>
          <span>
            <FontAwesomeIcon icon={faClock} />
          </span>
          <div>
            <h3>Pending Bookings</h3>
            <p className="summary-number">{stats.pending}</p>
          </div>
        </button>

        <button
          type="button"
          className="summary-card payment"
          onClick={() => setPaymentFilter("pending")}
        >
          <span>
            <FontAwesomeIcon icon={faMoneyBillWave} />
          </span>
          <div>
            <h3>Pending Payments</h3>
            <p className="summary-number">{stats.pendingPayments}</p>
          </div>
        </button>

        <button
          type="button"
          className="summary-card cancel"
          onClick={() => setFilter("cancel_requested")}
        >
          <span>
            <FontAwesomeIcon icon={faBan} />
          </span>
          <div>
            <h3>Cancel Requests</h3>
            <p className="summary-number">{stats.cancelRequests}</p>
          </div>
        </button>

        <button
          type="button"
          className="summary-card reschedule"
          onClick={() => setFilter("reschedule_requested")}
        >
          <span>
            <FontAwesomeIcon icon={faCalendarAlt} />
          </span>
          <div>
            <h3>Reschedule Requests</h3>
            <p className="summary-number">{stats.rescheduleRequests}</p>
          </div>
        </button>
      </section>

      <section className="booking-tools">
        <div className="booking-search-wrap">
          <input
            type="text"
            placeholder="Search by pet, owner, service, type, status, or booking ID..."
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            className="booking-search"
          />

          {searchTerm && (
            <button type="button" onClick={() => setSearchTerm("")}>
              <FontAwesomeIcon icon={faTimes} />
            </button>
          )}
        </div>

        <label className="booking-filter">
          <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}>
            {TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="booking-filter">
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

        <button type="button" className="clear-btn" onClick={clearFilters}>
          <FontAwesomeIcon icon={faFilter} />
          Clear
        </button>
      </section>

      <section className="filter-tabs">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.value}
            type="button"
            className={filter === tab.value ? "active" : ""}
            onClick={() => setFilter(tab.value)}
          >
            {tab.label}
          </button>
        ))}
      </section>

      <section className="bookings-table-container">
        <div className="bookings-table-header">
          <div>
            <span className="rb-eyebrow">
              <FontAwesomeIcon icon={faCalendarAlt} />
              Live Booking Queue
            </span>

            <h2>Bookings List</h2>

            <p>
              Showing <strong>{filteredBookings.length}</strong> of{" "}
              <strong>{bookings.length}</strong> booking(s).
            </p>
          </div>
        </div>

        {loading ? (
          <div className="booking-state">
            <FontAwesomeIcon icon={faSpinner} spin />
            <h3>Loading bookings...</h3>
            <p>Please wait while receptionist bookings are loaded.</p>
          </div>
        ) : (
          <div className="table-scroll">
            <table className="bookings-table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Pet</th>
                  <th>Owner</th>
                  <th>Service</th>
                  <th>Date</th>
                  <th>Time</th>
                  <th>Payment</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>

              <tbody>
                {filteredBookings.length === 0 && (
                  <tr>
                    <td colSpan="9">
                      <div className="empty-table-state">
                        <FontAwesomeIcon icon={faSearch} />
                        <h3>No bookings found</h3>
                        <p>Try changing your search keyword or filters.</p>
                      </div>
                    </td>
                  </tr>
                )}

                {filteredBookings.map((booking) => (
                  <tr key={`${booking.type}-${booking.id}`}>
                    <td>
                      <span className={`booking-type ${booking.type}`}>
                        <FontAwesomeIcon icon={getTypeIcon(booking.type)} />
                        {getTypeLabel(booking.type)}
                      </span>
                    </td>

                    <td>
                      <div className="pet-cell">
                        <strong>{booking.petName}</strong>
                        <small>
                          {booking.petType}
                          {booking.breed ? ` • ${booking.breed}` : ""}
                        </small>
                      </div>
                    </td>

                    <td>
                      <div className="owner-cell">
                        <FontAwesomeIcon icon={faUser} />
                        <span>{booking.owner}</span>
                      </div>
                    </td>

                    <td>{booking.service}</td>

                    <td>{formatDate(booking.appointmentDate || booking.checkIn)}</td>

                    <td>{formatTime(booking.appointmentTime)}</td>

                    <td>
                      <span className={`payment-status ${booking.paymentStatus || "pending"}`}>
                        {booking.paymentStatus || "pending"}
                      </span>
                    </td>

                    <td>
                      <span className={`status ${booking.status}`}>{booking.status}</span>
                    </td>

                    <td>
                      <RowActionPopover rowLabel={booking.petName || booking.owner}>
                        <div className="action-buttons">
                        <button
                          type="button"
                          className="action-btn details"
                          onClick={() => openDetailsModal(booking)}
                          title="View Details"
                        >
                          <FontAwesomeIcon icon={faEye} />
                        </button>

                        {booking.status === "pending" && (
                          <>
                            <button
                              type="button"
                              className="action-btn approve"
                              onClick={() => openActionModal(booking, "approve")}
                              title="Approve"
                            >
                              <FontAwesomeIcon icon={faCheck} />
                            </button>

                            <button
                              type="button"
                              className="action-btn reject"
                              onClick={() => openActionModal(booking, "reject")}
                              title="Reject"
                            >
                              <FontAwesomeIcon icon={faBan} />
                            </button>

                            <button
                              type="button"
                              className="action-btn reschedule"
                              onClick={() => openActionModal(booking, "reschedule")}
                              title="Reschedule"
                            >
                              <FontAwesomeIcon icon={faClock} />
                            </button>
                          </>
                        )}

                        {booking.status === "cancel_requested" && (
                          <>
                            <button
                              type="button"
                              className="action-btn approve"
                              onClick={() => openCancelModal(booking, "approve")}
                              title="Approve Cancel"
                            >
                              <FontAwesomeIcon icon={faCheck} />
                            </button>

                            <button
                              type="button"
                              className="action-btn reject"
                              onClick={() => openCancelModal(booking, "reject")}
                              title="Reject Cancel"
                            >
                              <FontAwesomeIcon icon={faBan} />
                            </button>
                          </>
                        )}

                        {booking.status === "reschedule_requested" && (
                          <>
                            <button
                              type="button"
                              className="action-btn approve"
                              onClick={() => openRescheduleModal(booking, "approve")}
                              title="Approve Reschedule"
                            >
                              <FontAwesomeIcon icon={faCheck} />
                            </button>

                            <button
                              type="button"
                              className="action-btn reject"
                              onClick={() => openRescheduleModal(booking, "reject")}
                              title="Reject Reschedule"
                            >
                              <FontAwesomeIcon icon={faBan} />
                            </button>
                          </>
                        )}

                        <button
                          type="button"
                          className="action-btn history"
                          onClick={() => openHistoryModal(booking)}
                          title="View History"
                        >
                          <FontAwesomeIcon icon={faHistory} />
                        </button>
                        </div>
                      </RowActionPopover>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {showActionModal && selectedBooking && (
        <div className="hbk-overlay" onClick={closeActionModal}>
          <div className="hbk-modal" onClick={(event) => event.stopPropagation()}>
            <div className="hbk-head">
              <div>
                <span className="rb-eyebrow">
                  <FontAwesomeIcon icon={faInfoCircle} />
                  Booking Action
                </span>

                <h2>
                  {actionType === "approve" && "Approve Booking"}
                  {actionType === "reject" && "Reject Booking"}
                  {actionType === "reschedule" && "Reschedule Booking"}
                </h2>
              </div>

              <button className="close-btn" type="button" onClick={closeActionModal}>
                <FontAwesomeIcon icon={faTimes} />
              </button>
            </div>

            <div className="hbk-body">
              <BookingSummary booking={selectedBooking} />

              {(actionType === "approve" || actionType === "reschedule") && (
                <div
                  className={`availability-check ${
                    availability?.available ? "available" : "unavailable"
                  }`}
                >
                  {checkingAvailability ? (
                    <p>
                      <FontAwesomeIcon icon={faSpinner} spin /> Checking availability...
                    </p>
                  ) : availability ? (
                    <>
                      <p>
                        <strong>Status:</strong>{" "}
                        {availability.available ? "Available" : "Not Available"}
                      </p>
                      <p>{availability.message}</p>
                    </>
                  ) : (
                    <p>Preparing availability check...</p>
                  )}
                </div>
              )}

              <form
                className="appointment-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  handleActionSubmit();
                }}
              >
                {actionType === "reschedule" && (
                  <div className="form-group">
                    <label>New Date</label>
                    <DatePickerInput
                      withPortal
                      selected={parseDateOnly(newDate)}
                      onChange={(date) => {
                        const dateStr = formatDateOnly(date);
                        setNewDate(dateStr);
                        checkAvailability(selectedBooking, dateStr);
                      }}
                      required
                    />
                  </div>
                )}

                <div className="form-group">
                  <label>
                    {actionType === "reject"
                      ? "Reason / Receptionist Note"
                      : "Receptionist Note"}
                  </label>
                  <textarea
                    value={actionNote}
                    onChange={(event) => setActionNote(event.target.value)}
                    placeholder={
                      actionType === "approve"
                        ? "Add approval note..."
                        : actionType === "reject"
                        ? "Provide reason for rejection..."
                        : "Add reschedule note..."
                    }
                    rows={4}
                  />
                </div>

                <div className="hbk-foot">
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={closeActionModal}
                    disabled={processing}
                  >
                    Cancel
                  </button>

                  <button
                    type="submit"
                    className="primary-btn"
                    disabled={
                      processing ||
                      (!availability?.available &&
                        (actionType === "approve" || actionType === "reschedule"))
                    }
                  >
                    {processing && <FontAwesomeIcon icon={faSpinner} spin />}
                    {actionType === "approve" && "Approve"}
                    {actionType === "reject" && "Reject"}
                    {actionType === "reschedule" && "Reschedule"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {showCancelModal && selectedCancelBooking && (
        <div className="hbk-overlay" onClick={closeCancelModal}>
          <div className="hbk-modal" onClick={(event) => event.stopPropagation()}>
            <div className="hbk-head">
              <div>
                <span className="rb-eyebrow">
                  <FontAwesomeIcon icon={faBan} />
                  Cancel Request
                </span>

                <h2>
                  {cancelAction === "approve"
                    ? "Approve Cancel Request"
                    : "Reject Cancel Request"}
                </h2>
              </div>

              <button className="close-btn" type="button" onClick={closeCancelModal}>
                <FontAwesomeIcon icon={faTimes} />
              </button>
            </div>

            <div className="hbk-body">
              <BookingSummary booking={selectedCancelBooking} />

              <form
                className="appointment-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  handleCancelSubmit();
                }}
              >
                <div className="form-group">
                  {cancelAction === "reject" ? (
                    <>
                      <label>Rejection Reason</label>
                      <select
                        value={cancelReason}
                        onChange={(event) => setCancelReason(event.target.value)}
                      >
                        <option value="" disabled>
                          Select a reason...
                        </option>
                        {CANCEL_REJECT_REASONS.map((reason) => (
                          <option key={reason} value={reason}>
                            {reason}
                          </option>
                        ))}
                        <option value="__other__">Other (please specify)</option>
                      </select>
                      {cancelReason === "__other__" && (
                        <textarea
                          value={cancelNote}
                          onChange={(event) => setCancelNote(event.target.value)}
                          placeholder="Type the reason for rejecting this cancellation..."
                          rows={3}
                          style={{ marginTop: "8px" }}
                        />
                      )}
                    </>
                  ) : (
                    <>
                      <label>Receptionist Note</label>
                      <textarea
                        value={cancelNote}
                        onChange={(event) => setCancelNote(event.target.value)}
                        placeholder="Add cancellation approval note..."
                        rows={4}
                      />
                    </>
                  )}
                </div>

                <div className="hbk-foot">
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={closeCancelModal}
                    disabled={processing}
                  >
                    Cancel
                  </button>

                  <button type="submit" className="primary-btn" disabled={processing}>
                    {processing && <FontAwesomeIcon icon={faSpinner} spin />}
                    {cancelAction === "approve" ? "Approve Cancel" : "Reject Cancel"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {showRescheduleModal && selectedRescheduleBooking && (
        <div className="hbk-overlay" onClick={closeRescheduleModal}>
          <div className="hbk-modal" onClick={(event) => event.stopPropagation()}>
            <div className="hbk-head">
              <div>
                <span className="rb-eyebrow">
                  <FontAwesomeIcon icon={faCalendarAlt} />
                  Reschedule Request
                </span>

                <h2>
                  {rescheduleAction === "approve"
                    ? "Approve Reschedule Request"
                    : "Reject Reschedule Request"}
                </h2>
              </div>

              <button className="close-btn" type="button" onClick={closeRescheduleModal}>
                <FontAwesomeIcon icon={faTimes} />
              </button>
            </div>

            <div className="hbk-body">
              <BookingSummary booking={selectedRescheduleBooking} />

              <form
                className="appointment-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  handleRescheduleSubmit();
                }}
              >
                {rescheduleAction === "approve" && (
                  <div className="form-group">
                    <label>Approved New Date</label>
                    <DatePickerInput
                      withPortal
                      selected={parseDateOnly(rescheduleNewDate)}
                      onChange={(date) => setRescheduleNewDate(formatDateOnly(date))}
                      placeholderText="mm/dd/yyyy"
                      required
                    />
                  </div>
                )}

                <div className="form-group">
                  <label>Receptionist Note</label>
                  <textarea
                    value={rescheduleNote}
                    onChange={(event) => setRescheduleNote(event.target.value)}
                    placeholder={
                      rescheduleAction === "approve"
                        ? "Add reschedule approval note..."
                        : "Provide reason for rejecting reschedule..."
                    }
                    rows={4}
                  />
                </div>

                <div className="hbk-foot">
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={closeRescheduleModal}
                    disabled={processing}
                  >
                    Cancel
                  </button>

                  <button type="submit" className="primary-btn" disabled={processing}>
                    {processing && <FontAwesomeIcon icon={faSpinner} spin />}
                    {rescheduleAction === "approve"
                      ? "Approve Reschedule"
                      : "Reject Reschedule"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {showDetailsModal && selectedDetailsBooking && (
        <div className="hbk-overlay" onClick={closeDetailsModal}>
          <div className="hbk-modal" onClick={(event) => event.stopPropagation()}>
            <div className="hbk-head">
              <div>
                <span className="rb-eyebrow">
                  <FontAwesomeIcon icon={faEye} />
                  Booking Details
                </span>
                <h2>{getTypeLabel(selectedDetailsBooking.type)} Booking</h2>
              </div>

              <button className="close-btn" type="button" onClick={closeDetailsModal}>
                <FontAwesomeIcon icon={faTimes} />
              </button>
            </div>

            <div className="hbk-body">
              <div className="detail-grid">
                <DetailItem label="Booking ID" value={selectedDetailsBooking.id} />
                <DetailItem label="Type" value={getTypeLabel(selectedDetailsBooking.type)} />
                <DetailItem label="Pet" value={selectedDetailsBooking.petName} />
                <DetailItem label="Pet Type" value={selectedDetailsBooking.petType} />
                <DetailItem label="Breed" value={selectedDetailsBooking.breed || "N/A"} />
                <DetailItem label="Owner" value={selectedDetailsBooking.owner} />
                <DetailItem label="Phone" value={selectedDetailsBooking.ownerPhone || "N/A"} />
                <DetailItem label="Service" value={selectedDetailsBooking.service} />
                <DetailItem
                  label="Date"
                  value={formatDate(
                    selectedDetailsBooking.appointmentDate || selectedDetailsBooking.checkIn
                  )}
                />
                <DetailItem
                  label="Time"
                  value={formatTime(selectedDetailsBooking.appointmentTime)}
                />
                <DetailItem
                  label="Amount"
                  value={formatCurrency(selectedDetailsBooking.amount)}
                />
                <DetailItem
                  label="Paid Amount"
                  value={formatCurrency(selectedDetailsBooking.paidAmount)}
                />
                <DetailItem label="Status" value={selectedDetailsBooking.status} />
                <DetailItem label="Payment" value={selectedDetailsBooking.paymentStatus} />
              </div>
            </div>

            <div className="hbk-foot">
              <button type="button" className="secondary-btn" onClick={closeDetailsModal}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {showHistoryModal && selectedHistoryBooking && (
        <div className="hbk-overlay" onClick={closeHistoryModal}>
          <div className="hbk-modal" onClick={(event) => event.stopPropagation()}>
            <div className="hbk-head">
              <div>
                <span className="rb-eyebrow">
                  <FontAwesomeIcon icon={faHistory} />
                  Booking Activity
                </span>
                <h2>Booking History</h2>
              </div>

              <button className="close-btn" type="button" onClick={closeHistoryModal}>
                <FontAwesomeIcon icon={faTimes} />
              </button>
            </div>

            <div className="hbk-body">
              <BookingSummary booking={selectedHistoryBooking} />

              <div className="history-timeline">
                {bookingHistory.length === 0 ? (
                  <p className="no-history">No history available.</p>
                ) : (
                  bookingHistory.map((historyItem, index) => (
                    <div key={historyItem.id || index} className="history-item">
                      <div className="history-timestamp">
                        {formatDateTime(historyItem.timestamp || historyItem.created_at)}
                      </div>

                      <div className="history-content">
                        <div className="history-action">
                          <strong>{historyItem.action || "Updated"}</strong>
                          {historyItem.status && (
                            <span className={`history-status ${historyItem.status}`}>
                              {historyItem.status}
                            </span>
                          )}
                        </div>

                        {historyItem.note && (
                          <div className="history-note">{historyItem.note}</div>
                        )}

                        {historyItem.user && (
                          <div className="history-user">by {historyItem.user}</div>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {showNewBookingModal && (
        <div className="hbk-overlay" onClick={handleBookingCancel}>
          <div
            className="hbk-modal hbk-modal-lg"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="hbk-head">
              <div>
                <span className="rb-eyebrow">
                  <FontAwesomeIcon icon={faPlus} />
                  Walk-in Transaction
                </span>
                <h2>New Booking</h2>
              </div>

              <button className="close-btn" type="button" onClick={handleBookingCancel}>
                <FontAwesomeIcon icon={faTimes} />
              </button>
            </div>

            <div className="hbk-body">
              <form className="appointment-form" onSubmit={handleBookingSubmit}>
                <div className="form-section-title">
                  <h3>Customer & Pet Information</h3>
                  <p>Select an existing customer and their registered pet.</p>
                </div>

                <div className="form-grid">
                  <div className="form-group">
                    <label>Booking Type *</label>
                    <select
                      name="bookingType"
                      value={bookingFormData.bookingType}
                      onChange={handleBookingInputChange}
                      required
                    >
                      <option value="hotel">Hotel</option>
                      <option value="vet">Veterinary</option>
                      <option value="grooming">Grooming</option>
                    </select>
                  </div>

                  <div className="form-group">
                    <label>Select Customer *</label>
                    <select
                      name="customerId"
                      value={bookingFormData.customerId}
                      onChange={(event) => handleCustomerChange(event.target.value)}
                      required
                    >
                      <option value="">Choose a customer...</option>
                      {customers.map((customer) => (
                        <option key={customer.id} value={customer.id}>
                          {customer.name || customer.full_name || "Customer"} (
                          {customer.phone || "No phone"})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="form-group">
                    <label>Select Pet *</label>
                    <select
                      name="petId"
                      value={bookingFormData.petId}
                      onChange={(event) => handlePetChange(event.target.value)}
                      required
                      disabled={!bookingFormData.customerId}
                    >
                      <option value="">
                        {bookingFormData.customerId
                          ? "Choose a pet..."
                          : "Select customer first"}
                      </option>

                      {getAvailablePets().map((pet) => (
                        <option key={pet.id} value={pet.id}>
                          {pet.name} ({pet.type || pet.species || "Pet"} -{" "}
                          {pet.breed || "Unknown breed"})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="form-group">
                    <label>Pet Name</label>
                    <input value={bookingFormData.petName} disabled />
                  </div>

                  <div className="form-group">
                    <label>Pet Type</label>
                    <input value={bookingFormData.petType} disabled />
                  </div>

                  <div className="form-group">
                    <label>Breed</label>
                    <input value={bookingFormData.breed} disabled />
                  </div>

                  <div className="form-group">
                    <label>Owner Name</label>
                    <input value={bookingFormData.ownerName} disabled />
                  </div>
                </div>

                <div className="form-section-title">
                  <h3>Schedule & Service</h3>
                  <p>Choose the date, time, and service information.</p>
                </div>

                <div className="form-grid">
                  <div className="form-group">
                    <label>Appointment Date *</label>
                    <DatePickerInput
                      selected={parseDateOnly(bookingFormData.appointmentDate)}
                      onChange={(date) => handleBookingInputChange({ target: { name: "appointmentDate", value: formatDateOnly(date) } })}
                      placeholderText="mm/dd/yyyy"
                      minDate={new Date()}
                      required
                    />
                  </div>

                  <div className="form-group">
                    <label>Appointment Time</label>
                    <select
                      name="appointmentTime"
                      value={bookingFormData.appointmentTime}
                      onChange={handleBookingInputChange}
                    >
                      <option value="10:00">10:00 AM</option>
                      <option value="11:00">11:00 AM</option>
                      <option value="14:00">2:00 PM</option>
                      <option value="15:00">3:00 PM</option>
                      <option value="16:00">4:00 PM</option>
                      <option value="17:00">5:00 PM</option>
                    </select>
                  </div>

                  {bookingFormData.bookingType === "hotel" && (
                    <>
                      <div className="form-group">
                        <label>Room Type *</label>
                        <select
                          name="roomType"
                          value={bookingFormData.roomType}
                          onChange={handleBookingInputChange}
                          required
                        >
                          <option value="Standard Room">Standard Room</option>
                          <option value="Deluxe Suite">Deluxe Suite</option>
                          <option value="Presidential Suite">Presidential Suite</option>
                        </select>
                      </div>

                      <div className="form-group">
                        <label>Duration *</label>
                        <select
                          name="duration"
                          value={bookingFormData.duration}
                          onChange={handleBookingInputChange}
                          required
                        >
                          <option value="1 day">1 day</option>
                          <option value="2 days">2 days</option>
                          <option value="3 days">3 days</option>
                          <option value="1 week">1 week</option>
                        </select>
                      </div>

                      <div className="form-group">
                        <label>Service *</label>
                        <select
                          name="service"
                          value={bookingFormData.service || "Pet Hotel Stay"}
                          onChange={handleBookingInputChange}
                          required
                        >
                          <option value="Pet Hotel Stay">Pet Hotel Stay</option>
                          <option value="Day Care">Day Care</option>
                          <option value="Pet Training">Pet Training</option>
                        </select>
                      </div>
                    </>
                  )}

                  {bookingFormData.bookingType === "vet" && (
                    <>
                      <div className="form-group">
                        <label>Service *</label>
                        <select
                          name="service"
                          value={bookingFormData.service}
                          onChange={handleBookingInputChange}
                          required
                        >
                          <option value="">Select a service</option>
                          {vetServices.map((service) => (
                            <option key={service.id} value={service.id}>
                              {service.name} - {formatCurrency(service.price)}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div className="form-group full">
                        <label>Symptoms</label>
                        <textarea
                          name="symptoms"
                          value={bookingFormData.symptoms}
                          onChange={handleBookingInputChange}
                          placeholder="Describe symptoms or reason for visit..."
                        />
                      </div>

                      <div className="form-group full">
                        <label>Medical Notes</label>
                        <textarea
                          name="medicalNotes"
                          value={bookingFormData.medicalNotes}
                          onChange={handleBookingInputChange}
                          placeholder="Optional medical notes..."
                        />
                      </div>
                    </>
                  )}

                  {bookingFormData.bookingType === "grooming" && (
                    <div className="form-group">
                      <label>Service *</label>
                      <select
                        name="service"
                        value={bookingFormData.service}
                        onChange={handleBookingInputChange}
                        required
                      >
                        <option value="">Select a service</option>
                        {groomingServices.map((service) => (
                          <option key={service.id} value={service.id}>
                            {service.name} - {formatCurrency(service.price)}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  <div className="form-group full">
                    <label>Special Requests</label>
                    <textarea
                      name="specialRequests"
                      value={bookingFormData.specialRequests}
                      onChange={handleBookingInputChange}
                      placeholder="Any special requests or notes..."
                    />
                  </div>
                </div>

                <div className="form-section-title">
                  <h3>Payment Information</h3>
                  <p>Payment verification is still handled by the cashier.</p>
                </div>

                <div className="payment-preview-card">
                  <div>
                    <span>Estimated Amount</span>
                    <strong>{formatCurrency(calculatedAmount)}</strong>
                  </div>

                  <div>
                    <span>Paid Amount</span>
                    <strong>{formatCurrency(bookingFormData.paidAmount)}</strong>
                  </div>

                  <div>
                    <span>Payment Status</span>
                    <strong>
                      {getPaymentStatusFromAmount(
                        calculatedAmount,
                        bookingFormData.paidAmount
                      )}
                    </strong>
                  </div>
                </div>

                <div className="form-grid">
                  <div className="form-group">
                    <label>Payment Method *</label>
                    <select
                      name="paymentMethod"
                      value={bookingFormData.paymentMethod}
                      onChange={handleBookingInputChange}
                      required
                    >
                      <option value="cash">Cash</option>
                      <option value="card">Credit Card</option>
                      <option value="gcash">GCash</option>
                      <option value="bank">Bank Transfer</option>
                    </select>
                  </div>

                  <div className="form-group">
                    <label>Paid Amount</label>
                    <input
                      type="number"
                      name="paidAmount"
                      value={bookingFormData.paidAmount}
                      onChange={handleBookingInputChange}
                      placeholder="0.00"
                      min="0"
                      step="0.01"
                    />
                  </div>
                </div>

                <div className="hbk-foot">
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={handleBookingCancel}
                    disabled={processing}
                  >
                    Cancel
                  </button>

                  <button type="submit" className="primary-btn" disabled={processing}>
                    {processing && <FontAwesomeIcon icon={faSpinner} spin />}
                    Create Booking
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const BookingSummary = ({ booking }) => (
  <div className="booking-details-summary">
    <div>
      <small>Pet</small>
      <strong>{booking.petName}</strong>
    </div>

    <div>
      <small>Owner</small>
      <strong>{booking.owner}</strong>
    </div>

    <div>
      <small>Service</small>
      <strong>{booking.service}</strong>
    </div>

    <div>
      <small>Date</small>
      <strong>{formatDate(booking.appointmentDate || booking.checkIn)}</strong>
    </div>

    <div>
      <small>Amount</small>
      <strong>{formatCurrency(booking.amount)}</strong>
    </div>

    <div>
      <small>Status</small>
      <strong>{booking.status}</strong>
    </div>
  </div>
);

const DetailItem = ({ label, value }) => (
  <div className="detail-item">
    <small>{label}</small>
    <strong>{value || "N/A"}</strong>
  </div>
);

export default ReceptionistBookings;
