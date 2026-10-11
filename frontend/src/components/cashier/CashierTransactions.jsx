import React, { useState, useEffect, useRef } from "react";
import { showAlert, showPrompt, showError } from "../../utils/alert.jsx";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faSearch,
  faFilter,
  faPlus,
  faEdit,
  faTrash,
  faReceipt,
  faCreditCard,
  faMoneyBillWave,
  faMobileScreen,
  faWallet,
  faCalendarAlt,
  faShoppingCart,
  faEye,
  faSpinner,
} from "@fortawesome/free-solid-svg-icons";
import "./CashierTransactions_Polished.css";
import { formatCurrency } from "../../utils/currency";
import { posApi } from "../../api/pos";
import { printReceipt } from "../../utils/receiptPrinter";
import { computeVatBreakdown } from "../../utils/storeInfo";
import { useNavigate } from "react-router-dom";
import RowActionPopover from "../shared/RowActionPopover";

const isGenericFetchFailure = (error) =>
  error?.name === "TypeError" && error?.message === "Failed to fetch";

const CashierTransactions = () => {
  const navigate = useNavigate();
  const [searchTerm, setSearchTerm] = useState("");
  const [filterStatus, setFilterStatus] = useState("all");
  const [selectedTransaction, setSelectedTransaction] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [pagination, setPagination] = useState({
    current_page: 1,
    last_page: 1,
    total: 0,
  });

  const searchDebounceRef = useRef(null);

  useEffect(() => {
    loadTransactions(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterStatus]);

  useEffect(() => {
    clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => {
      loadTransactions(1);
    }, 400);
    return () => clearTimeout(searchDebounceRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchTerm]);

  const loadTransactions = async (page = 1) => {
    try {
      setLoading(true);
      setError("");
      const params = { per_page: 20, page };
      if (filterStatus !== "all") {
        params.status = filterStatus;
      }
      if (searchTerm.trim()) {
        params.search = searchTerm.trim();
      }
      const response = await posApi.getTransactions(params);
      
      const transformedData = (response.data || []).map(sale => ({
        id: sale.transaction_number || `TRX-${sale.id}`,
        sale_id: sale.id,
        customer: sale.customer?.name || "Walk-in",
        email: sale.customer?.email || "",
        amount: parseFloat(sale.total_amount || sale.amount || 0),
        items: sale.items?.length || 0,
        payment: sale.payments?.[0]?.payment_method || "Cash",
        paymentMethod: mapPaymentMethod(sale.payments?.[0]?.payment_method),
        date: new Date(sale.created_at).toISOString().split('T')[0],
        time: new Date(sale.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        status: sale.status,
        products: (sale.items || []).map(item => ({
          name: item.item_name,
          quantity: item.quantity,
          price: parseFloat(item.total_price),
        })),
        raw_data: sale, 
      }));
      
      setTransactions(transformedData);
      setPagination({
        current_page: response.current_page || 1,
        last_page: response.last_page || 1,
        total: response.total || transformedData.length,
      });
    } catch (err) {
      setError("Failed to load transactions");
      showError("Failed to load transactions");
      if (!isGenericFetchFailure(err)) {
        console.error("Load transactions error:", err);
      }
    } finally {
      setLoading(false);
    }
  };

  const mapPaymentMethod = (method) => {
    const map = {
      'cash': 'cash',
      'credit_card': 'visa',
      'debit_card': 'mastercard',
      'gcash': 'gcash',
      'maya': 'maya',
    };
    return map[method] || 'cash';
  };

  const handlePrintReceipt = (transaction) => {
    // Fix: API returns "items" not "products" — check both for safety
    const rawItems = transaction.items || transaction.products || [];
    const items = rawItems.map((item) => ({
      name: item.item_name || item.name || "Item",
      quantity: item.quantity || 1,
      unitPrice: Number(item.unit_price || item.price || 0),
      total: Number(item.total_price || (item.unit_price || item.price || 0) * (item.quantity || 1)),
    }));

    const total = Number(transaction.amount || transaction.total_amount || 0);
    const subtotal = Number(transaction.subtotal || total);
    const discount = Number(transaction.discount || transaction.discount_amount || 0);
    const vat = Number(transaction.tax || transaction.tax_amount || 0);
    const amountReceived = Number(transaction.amount_received || transaction.cash_received || 0);
    const change = Number(transaction.change || transaction.change_amount || 0);

    printReceipt({
      title: "Sales Invoice",
      receiptNumber: transaction.transaction_number || String(transaction.id),
      date: `${transaction.date || ""} ${transaction.time || ""}`.trim() || new Date().toLocaleString("en-PH"),
      cashier: transaction.cashier_name || transaction.cashier || "Cashier",
      customer: transaction.customer || transaction.customer_name || "Walk-in",
      paymentMethod: transaction.payment || transaction.payment_method || "cash",
      paymentStatus: transaction.status || "paid",
      referenceNumber: transaction.reference_number || "",
      items,
      subtotal,
      vat: vat || undefined,
      discount,
      total,
      amountReceived: amountReceived || undefined,
      change: change || undefined,
    });
  };

  const handleVoidTransaction = async (id, reason) => {
    try {
      setLoading(true);
      const result = await posApi.voidTransaction(id, reason);
      if (result.success) {
        await loadTransactions(pagination.current_page);
      }
    } catch (err) {
      setError("Failed to void transaction");
      showError("Failed to void transaction");
    } finally {
      setLoading(false);
    }
  };

  const filteredTransactions = transactions.filter((transaction) => {
    return filterStatus === "all" || transaction.status === filterStatus;
  });

  const getStatusColor = (status) => {
    switch (status) {
      case "completed":
        return "success";
      case "pending":
        return "warning";
      case "cancelled":
        return "danger";
      default:
        return "info";
    }
  };

  const getPaymentIcon = (method) => {
    switch (method) {
      case "visa":
      case "mastercard":
        return faCreditCard;
      case "gcash":
        return faMobileScreen;
      case "maya":
        return faWallet;
      case "cash":
        return faMoneyBillWave;
      default:
        return faReceipt;
    }
  };

  return (
    <div className="cashier-transactions">
      <div className="transactions-header">
        <div className="header-left">
          <h1>Transaction Management</h1>
          <p>View and manage all customer transactions</p>
        </div>
        <div className="header-actions">
          <button className="primary-btn" onClick={() => navigate('/cashier/pos')}>
            <FontAwesomeIcon icon={faPlus} />
            New Transaction
          </button>
        </div>
      </div>

      <div className="transactions-controls">
        <div className="search-filter-group">
          <div className="search-box">
            <FontAwesomeIcon icon={faSearch} />
            <input
              type="text"
              placeholder="Search by customer, transaction ID, or email..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
          <div className="filter-dropdown">
            <FontAwesomeIcon icon={faFilter} />
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
            >
              <option value="all">All Status</option>
              <option value="completed">Completed</option>
              <option value="pending">Pending</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>
        </div>
      </div>

      {loading && (
        <div className="loading-overlay">
          <FontAwesomeIcon icon={faSpinner} spin />
          <span>Loading transactions...</span>
        </div>
      )}
      
      {error && <div className="error-banner">{error}</div>}

      <div className="transactions-table-container">
        <table className="transactions-table">
          <thead>
            <tr>
              <th>Transaction ID</th>
              <th>Customer</th>
              <th>Items</th>
              <th>Amount</th>
              <th>Payment</th>
              <th>Date & Time</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredTransactions.map((transaction) => (
              <tr key={transaction.id} className="transaction-row">
                <td className="transaction-id">
                  <FontAwesomeIcon icon={faReceipt} />
                  {transaction.id}
                </td>
                <td className="customer-info">
                  <div className="customer-details">
                    <span className="customer-name">{transaction.customer}</span>
                    <span className="customer-email">{transaction.email}</span>
                  </div>
                </td>
                <td className="items-count">
                  <FontAwesomeIcon icon={faShoppingCart} />
                  {transaction.items} items
                </td>
                <td className="amount">{formatCurrency(transaction.amount)}</td>
                <td className="payment-method">
                  <FontAwesomeIcon icon={getPaymentIcon(transaction.paymentMethod)} />
                  {transaction.payment}
                </td>
                <td className="datetime">
                  <div>
                    <FontAwesomeIcon icon={faCalendarAlt} />
                    {transaction.date}
                  </div>
                  <span className="time">{transaction.time}</span>
                </td>
                <td className="status">
                  <span className={`status-badge ${getStatusColor(transaction.status)}`}>
                    {transaction.status}
                  </span>
                </td>
                <td className="actions">
                  <RowActionPopover rowLabel={transaction.customer || transaction.id}>
                  <button
                    className="action-btn view"
                    onClick={() => setSelectedTransaction(transaction)}
                    title="View Details"
                  >
                    <FontAwesomeIcon icon={faEye} />
                  </button>
                  <button 
                    className="action-btn edit" 
                    title="Edit"
                    onClick={() => showAlert('Edit feature coming soon!')}
                  >
                    <FontAwesomeIcon icon={faEdit} />
                  </button>
                  <button 
                    className="action-btn delete" 
                    title="Void"
                    onClick={async () => {
                      const reason = await showPrompt("Enter reason for voiding:");
                      if (reason) handleVoidTransaction(transaction.sale_id, reason);
                    }}
                    disabled={transaction.status === 'cancelled'}
                  >
                    <FontAwesomeIcon icon={faTrash} />
                  </button>
                  </RowActionPopover>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {pagination.last_page > 1 && (
        <div className="pagination">
          <button 
            className="page-btn" 
            disabled={pagination.current_page === 1}
            onClick={() => loadTransactions(pagination.current_page - 1)}
          >
            Previous
          </button>
          {Array.from({ length: pagination.last_page }, (_, i) => i + 1).map(page => (
            <button
              key={page}
              className={`page-btn ${pagination.current_page === page ? 'active' : ''}`}
              onClick={() => loadTransactions(page)}
            >
              {page}
            </button>
          ))}
          <button 
            className="page-btn" 
            disabled={pagination.current_page === pagination.last_page}
            onClick={() => loadTransactions(pagination.current_page + 1)}
          >
            Next
          </button>
        </div>
      )}

      {selectedTransaction && (
        <div className="transaction-modal-overlay" onClick={() => setSelectedTransaction(null)}>
          <div className="transaction-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Transaction Details</h2>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button
                  className="btn-secondary"
                  type="button"
                  onClick={() => handlePrintReceipt(selectedTransaction)}
                  style={{ fontSize: 13, padding: "6px 12px" }}
                >
                  <FontAwesomeIcon icon={faReceipt} /> Print Receipt
                </button>
                <button
                  className="close-btn"
                  onClick={() => setSelectedTransaction(null)}
                >
                  ×
                </button>
              </div>
            </div>
            <div className="modal-content">
              <div className="transaction-overview">
                <div className="overview-item">
                  <label>Transaction ID:</label>
                  <span>{selectedTransaction.id}</span>
                </div>
                <div className="overview-item">
                  <label>Customer:</label>
                  <span>{selectedTransaction.customer}</span>
                </div>
                <div className="overview-item">
                  <label>Email:</label>
                  <span>{selectedTransaction.email}</span>
                </div>
                <div className="overview-item">
                  <label>Date:</label>
                  <span>{selectedTransaction.date} at {selectedTransaction.time}</span>
                </div>
                <div className="overview-item">
                  <label>Payment Method:</label>
                  <span>{selectedTransaction.payment}</span>
                </div>
                <div className="overview-item">
                  <label>Status:</label>
                  <span className={`status-badge ${getStatusColor(selectedTransaction.status)}`}>
                    {selectedTransaction.status}
                  </span>
                </div>
              </div>
              
              <div className="transaction-products">
                <h3>Products</h3>
                <table className="products-table">
                  <thead>
                    <tr>
                      <th>Product Name</th>
                      <th>Quantity</th>
                      <th>Price</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedTransaction.products.map((product, index) => (
                      <tr key={index}>
                        <td>{product.name}</td>
                        <td>{product.quantity}</td>
                        <td>{formatCurrency(product.price)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan="2">Net Amount (ex-VAT):</td>
                      <td>{formatCurrency(computeVatBreakdown(selectedTransaction.amount).subtotalExVat)}</td>
                    </tr>
                    <tr>
                      <td colSpan="2">VAT (12%):</td>
                      <td>{formatCurrency(Number(selectedTransaction.raw_data?.tax_amount ?? computeVatBreakdown(selectedTransaction.amount).vatAmount))}</td>
                    </tr>
                    <tr className="total-row">
                      <td colSpan="2">Total:</td>
                      <td className="total-amount">{formatCurrency(selectedTransaction.amount)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default CashierTransactions;
