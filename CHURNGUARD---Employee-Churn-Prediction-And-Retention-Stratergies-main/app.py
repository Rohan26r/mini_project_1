"""
Flask backend — ChurnGuard Dashboard + Exit Interview Agent + SQLite Auth (Flask 3.x compatible)
Single app on port 5000.

✅ Dashboard + prediction logic kept
✅ Exit interview feature kept
✅ SQLite auth added (welcome/signup/login/logout)
✅ Flask 3.x compatible (no before_first_request)
✅ Fixes employeeId formats: 622 / "622" / "#622"
✅ Protects dashboard + APIs behind login
"""
import os, io
import sqlite3
from functools import wraps
from datetime import datetime

import numpy as np
import pandas as pd
import joblib

from flask import (
    Flask, request, jsonify, send_from_directory,
    render_template, redirect, url_for, session
)

from dotenv import load_dotenv
import requests as http_requests
from werkzeug.security import generate_password_hash, check_password_hash

# ──────────────────────────────────────────────────────────────
# App setup
# ──────────────────────────────────────────────────────────────
load_dotenv()

app = Flask(__name__, static_folder="static", template_folder="templates")
app.secret_key = os.environ.get("FLASK_SECRET_KEY", "dev_secret_change_me")  # required for sessions

# ──────────────────────────────────────────────────────────────
# Model (unchanged)
# ──────────────────────────────────────────────────────────────
MODEL_PATH = os.path.join(os.path.dirname(__file__), "employee_churn_gb_pipeline.pkl")
pipe = joblib.load(MODEL_PATH)

DROP_COLS = ["EmployeeCount", "StandardHours", "Over18", "EmployeeNumber"]
TARGET_COL = "Attrition"

LOW_Q = 0.60
HIGH_Q = 0.90


def risk_label(prob, low_th, high_th):
    if prob <= low_th:
        return "LOW"
    elif prob <= high_th:
        return "MEDIUM"
    return "HIGH"


# ──────────────────────────────────────────────────────────────
# Auth: SQLite (Flask 3.x compatible)
# ──────────────────────────────────────────────────────────────
DB_PATH = os.path.join(os.path.dirname(__file__), "users.db")


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_auth_db():
    conn = get_db()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            email TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
    """)
    conn.commit()
    conn.close()


init_auth_db()  # Flask 3.x: init once at startup


def login_required(view_func):
    @wraps(view_func)
    def wrapper(*args, **kwargs):
        if not session.get("user_id"):
            return redirect(url_for("welcome"))
        return view_func(*args, **kwargs)
    return wrapper


# ──────────────────────────────────────────────────────────────
# Groq Config (unchanged)
# ──────────────────────────────────────────────────────────────
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
GROQ_MODEL = "llama-3.3-70b-versatile"
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"

# ──────────────────────────────────────────────────────────────
# In-memory stores
# ──────────────────────────────────────────────────────────────
interview_sessions = {}      # session_id -> { employee, persona, messages[] }
employee_store = {}          # populated after CSV upload

EDUCATION_MAP = {1: "Below College", 2: "College", 3: "Bachelor's", 4: "Master's", 5: "Doctorate"}
SATISFACTION_MAP = {1: "Very Low", 2: "Low", 3: "High", 4: "Very High"}
WLB_MAP = {1: "Bad", 2: "Good", 3: "Better", 4: "Best"}


def normalize_emp_id(x):
    """Frontend may send: 622, "622", "#622" -> return int or None."""
    if x is None:
        return None
    if isinstance(x, int):
        return x
    s = str(x).strip()
    if s.startswith("#"):
        s = s[1:]
    return int(s) if s.isdigit() else None


# ──────────────────────────────────────────────────────────────
# Persona builder
# ──────────────────────────────────────────────────────────────
def build_persona(emp, dept_avg_income):
    age = emp.get("age", "?")
    gender = emp.get("gender", "?")
    marital = emp.get("maritalStatus", "?")
    dept = emp.get("department", "?")
    role = emp.get("jobRole", "?")
    income = emp.get("monthlyIncome", 0)
    overtime = emp.get("overTime", "No")
    job_sat = emp.get("jobSatisfaction", 3)
    env_sat = emp.get("environmentSatisfaction", 3)
    wlb = emp.get("workLifeBalance", 3)
    yrs_promo = emp.get("yearsSinceLastPromotion", 0)
    yrs_role = emp.get("yearsInCurrentRole", 0)
    yrs_company = emp.get("yearsAtCompany", 0)
    education = emp.get("education", 1)
    edu_field = emp.get("educationField", "?")
    distance = emp.get("distanceFromHome", 0)
    hike = emp.get("percentSalaryHike", 15)
    stock = emp.get("stockOptionLevel", 0)
    num_companies = emp.get("numCompaniesWorked", 0)
    job_level = emp.get("jobLevel", 1)
    job_involve = emp.get("jobInvolvement", 3)
    rel_sat = emp.get("relationshipSatisfaction", 3)
    training = emp.get("trainingTimesLastYear", 3)
    yrs_mgr = emp.get("yearsWithCurrManager", 0)
    total_yrs = emp.get("totalWorkingYears", 0)
    churn_prob = emp.get("churnProbability", 0)
    risk = emp.get("riskLevel", "LOW")
    travel = emp.get("businessTravel", "Non-Travel")
    perf = emp.get("performanceRating", 3)

    if dept_avg_income > 0:
        income_ratio = income / dept_avg_income
        if income_ratio < 0.5:
            income_note = f"${income:,}/month (severely below dept avg ${dept_avg_income:,.0f})"
        elif income_ratio < 0.8:
            income_note = f"${income:,}/month (below dept avg ${dept_avg_income:,.0f})"
        elif income_ratio < 1.0:
            income_note = f"${income:,}/month (slightly below dept avg ${dept_avg_income:,.0f})"
        else:
            income_note = f"${income:,}/month (at/above dept avg)"
    else:
        income_note = f"${income:,}/month"

    pain_points = []
    if income < 4000:
        pain_points.append("LOW PAY")
    if overtime == "Yes":
        pain_points.append("OVERTIME BURNOUT")
    if yrs_promo >= 3:
        pain_points.append("NO PROMOTION")
    if job_sat <= 2:
        pain_points.append("JOB DISSATISFACTION")
    if wlb <= 2:
        pain_points.append("POOR WORK-LIFE BALANCE")
    if env_sat <= 2:
        pain_points.append("BAD WORK ENVIRONMENT")
    if distance > 20:
        pain_points.append("LONG COMMUTE")
    if rel_sat <= 2:
        pain_points.append("POOR WORKPLACE RELATIONSHIPS")
    if training == 0:
        pain_points.append("ZERO TRAINING/GROWTH")
    if stock == 0 and job_level >= 2:
        pain_points.append("NO STOCK OPTIONS")
    if hike <= 12:
        pain_points.append("LOW SALARY HIKE")
    if not pain_points:
        pain_points = ["GENERAL DISSATISFACTION"]

    personality_lines = []
    if churn_prob > 0.5:
        personality_lines.append("You are seriously considering leaving and already exploring other offers.")
    elif churn_prob > 0.3:
        personality_lines.append("You’re frustrated but still open to strong, concrete fixes.")
    else:
        personality_lines.append("You have concerns but mainly want to feel heard and supported.")

    if num_companies >= 5:
        personality_lines.append("You know the market and aren’t afraid to switch.")
    if age < 30:
        personality_lines.append("You’re early-career with many options.")
    if age > 50:
        personality_lines.append("You value stability but want respect for experience.")
    if total_yrs > 15 and job_level <= 2:
        personality_lines.append("You feel undervalued for your experience level.")

    travel_note = ""
    if travel == "Travel_Frequently":
        travel_note = "- Frequent travel adds stress\n"
    elif travel == "Non-Travel":
        travel_note = "- No travel opportunities may limit exposure\n"

    perf_note = ""
    if perf == 4 and hike <= 15:
        perf_note = f"- Outstanding rating (4/4) but hike only {hike}% feels unfair\n"
    elif perf == 3:
        perf_note = f"- Performance rating is Excellent (3/4)\n"

    personality_block = "\n".join("- " + line for line in personality_lines)

    prompt = f"""You are a {age}-year-old {marital} {gender} working as a {role} in the {dept} department.

YOUR SITUATION:
- Monthly Income: {income_note}
- OverTime: {"You work overtime regularly — it's exhausting" if overtime == "Yes" else "No overtime, but other issues exist"}
- Job Satisfaction: {job_sat}/4 ({SATISFACTION_MAP.get(job_sat, '?')})
- Work-Life Balance: {wlb}/4 ({WLB_MAP.get(wlb, '?')})
- Environment Satisfaction: {env_sat}/4 ({SATISFACTION_MAP.get(env_sat, '?')})
- Relationship Satisfaction: {rel_sat}/4 ({SATISFACTION_MAP.get(rel_sat, '?')})
- Job Involvement: {job_involve}/4 ({SATISFACTION_MAP.get(job_involve, '?')})
- Last Promotion: {yrs_promo} year(s) ago
- Years in Current Role: {yrs_role}
- Years at Company: {yrs_company}
- Job Level: {job_level}/5
- Education: {EDUCATION_MAP.get(education, '?')} in {edu_field}
- Commute: {distance} km daily
- Salary Hike last year: {hike}%
- Stock Options: {"None" if stock == 0 else f"Level {stock}"}
- Training sessions last year: {training}
- Years with current manager: {yrs_mgr}
- Total experience: {total_yrs} years
- Previously worked at {num_companies} companies
{travel_note}{perf_note}
YOUR CHURN RISK: {risk}

YOUR PERSONALITY:
- Main pain points: {', '.join(pain_points)}
{personality_block}

RULES:
1) You are in an EXIT INTERVIEW with HR.
2) Stay in character. Never mention AI/models/probabilities.
3) Push back on vague promises. Ask for specifics.
4) If HR offers concrete actions, soften gradually.
5) Don’t reveal everything at once.
6) Keep answers 2–4 sentences usually.

Start by waiting for the HR manager to speak first."""
    return prompt.strip()


# ──────────────────────────────────────────────────────────────
# Groq calls
# ──────────────────────────────────────────────────────────────
def call_groq(messages):
    headers = {"Authorization": f"Bearer {GROQ_API_KEY}", "Content-Type": "application/json"}
    body = {"model": GROQ_MODEL, "messages": messages, "temperature": 0.8, "max_tokens": 512}
    resp = http_requests.post(GROQ_URL, headers=headers, json=body, timeout=30)
    resp.raise_for_status()
    return resp.json()["choices"][0]["message"]["content"]


def call_groq_feedback(messages, employee):
    feedback_prompt = f"""You are an HR training evaluator.

Employee profile:
- Risk Level: {employee['riskLevel']}
- Churn Probability: {employee['churnProbability']*100:.0f}%
- OverTime={employee.get('overTime','?')}
- JobSatisfaction={employee.get('jobSatisfaction','?')}/4
- MonthlyIncome=${employee.get('monthlyIncome',0):,}
- YearsSinceLastPromotion={employee.get('yearsSinceLastPromotion',0)}

Evaluate HR performance:
1) Empathy (1-5⭐)
2) Active Listening (1-5⭐)
3) Solution Quality (1-5⭐)
4) Retention Likelihood (%)

Then: Strengths, Areas to Improve, Recommended Approach.
Reference actual things said."""
    eval_messages = messages + [{"role": "user", "content": feedback_prompt}]

    headers = {"Authorization": f"Bearer {GROQ_API_KEY}", "Content-Type": "application/json"}
    body = {"model": GROQ_MODEL, "messages": eval_messages, "temperature": 0.4, "max_tokens": 1024}
    resp = http_requests.post(GROQ_URL, headers=headers, json=body, timeout=30)
    resp.raise_for_status()
    return resp.json()["choices"][0]["message"]["content"]


# ──────────────────────────────────────────────────────────────
# AUTH ROUTES
# ──────────────────────────────────────────────────────────────
@app.route("/welcome")
def welcome():
    if session.get("user_id"):
        return redirect(url_for("home"))
    return render_template("welcome.html")


@app.route("/signup", methods=["GET", "POST"])
def signup():
    if session.get("user_id"):
        return redirect(url_for("home"))

    error = None
    if request.method == "POST":
        name = request.form.get("name", "").strip()
        email = request.form.get("email", "").strip().lower()
        password = request.form.get("password", "")
        confirm = request.form.get("confirm_password", "")

        if not name or not email or not password:
            error = "Please fill all required fields."
        elif len(password) < 6:
            error = "Password must be at least 6 characters."
        elif password != confirm:
            error = "Passwords do not match."
        else:
            try:
                conn = get_db()
                conn.execute(
                    "INSERT INTO users (name, email, password_hash, created_at) VALUES (?, ?, ?, ?)",
                    (name, email, generate_password_hash(password), datetime.utcnow().isoformat())
                )
                conn.commit()
                row = conn.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()
                conn.close()

                session["user_id"] = row["id"]
                session["user_name"] = name
                session["user_email"] = email
                return redirect(url_for("home"))
            except sqlite3.IntegrityError:
                error = "This email is already registered. Try logging in."
            except Exception as e:
                error = f"Signup failed: {str(e)}"

    return render_template("signup.html", error=error)


@app.route("/login", methods=["GET", "POST"])
def login():
    if session.get("user_id"):
        return redirect(url_for("home"))

    error = None
    if request.method == "POST":
        email = request.form.get("email", "").strip().lower()
        password = request.form.get("password", "")

        if not email or not password:
            error = "Please enter email and password."
        else:
            conn = get_db()
            user = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
            conn.close()

            if not user:
                error = "No account found with this email."
            elif not check_password_hash(user["password_hash"], password):
                error = "Incorrect password."
            else:
                session["user_id"] = user["id"]
                session["user_name"] = user["name"]
                session["user_email"] = user["email"]
                return redirect(url_for("home"))

    return render_template("login.html", error=error)


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("welcome"))


# ──────────────────────────────────────────────────────────────
# HOME/DASHBOARD PAGE (ONLY ONE "/" ROUTE!)
# ──────────────────────────────────────────────────────────────
@app.route("/")
def home():
    # not logged in → welcome
    if not session.get("user_id"):
        return redirect(url_for("welcome"))
    # logged in → dashboard
    return send_from_directory("templates", "index.html")


# ──────────────────────────────────────────────────────────────
# DASHBOARD API (protected)
# ──────────────────────────────────────────────────────────────
@app.route("/predict", methods=["POST"])
@login_required
def predict():
    if "file" not in request.files:
        return jsonify({"error": "No file uploaded"}), 400

    file = request.files["file"]
    if not file.filename.endswith(".csv"):
        return jsonify({"error": "Only CSV files are accepted"}), 400

    try:
        df = pd.read_csv(file)
    except Exception as e:
        return jsonify({"error": f"Failed to read CSV: {str(e)}"}), 400

    emp_ids = df["EmployeeNumber"].tolist() if "EmployeeNumber" in df.columns else list(range(1, len(df) + 1))

    has_actual = TARGET_COL in df.columns
    actuals = None
    if has_actual:
        actuals = df[TARGET_COL].map({"Yes": 1, "No": 0}).fillna(0).astype(int).tolist()

    cols_to_drop = [c for c in DROP_COLS + [TARGET_COL] if c in df.columns]
    X = df.drop(columns=cols_to_drop)

    probas = pipe.predict_proba(X)[:, 1]
    preds = pipe.predict(X)

    low_th = float(np.quantile(probas, LOW_Q))
    high_th = float(np.quantile(probas, HIGH_Q))

    dept_incomes = {}
    if "Department" in df.columns and "MonthlyIncome" in df.columns:
        dept_incomes = df.groupby("Department")["MonthlyIncome"].mean().to_dict()

    employees = []
    for i in range(len(df)):
        dept = str(df.iloc[i].get("Department", ""))
        emp = {
            "id": int(emp_ids[i]) if str(emp_ids[i]).isdigit() else emp_ids[i],
            "age": int(df.iloc[i].get("Age", 0)),
            "gender": str(df.iloc[i].get("Gender", "")),
            "maritalStatus": str(df.iloc[i].get("MaritalStatus", "")),
            "department": dept,
            "jobRole": str(df.iloc[i].get("JobRole", "")),
            "jobLevel": int(df.iloc[i].get("JobLevel", 1)),
            "monthlyIncome": int(df.iloc[i].get("MonthlyIncome", 0)),
            "overTime": str(df.iloc[i].get("OverTime", "")),
            "jobSatisfaction": int(df.iloc[i].get("JobSatisfaction", 0)),
            "environmentSatisfaction": int(df.iloc[i].get("EnvironmentSatisfaction", 0)),
            "workLifeBalance": int(df.iloc[i].get("WorkLifeBalance", 0)),
            "relationshipSatisfaction": int(df.iloc[i].get("RelationshipSatisfaction", 3)),
            "jobInvolvement": int(df.iloc[i].get("JobInvolvement", 3)),
            "yearsAtCompany": int(df.iloc[i].get("YearsAtCompany", 0)),
            "yearsInCurrentRole": int(df.iloc[i].get("YearsInCurrentRole", 0)),
            "yearsSinceLastPromotion": int(df.iloc[i].get("YearsSinceLastPromotion", 0)),
            "yearsWithCurrManager": int(df.iloc[i].get("YearsWithCurrManager", 0)),
            "distanceFromHome": int(df.iloc[i].get("DistanceFromHome", 0)),
            "numCompaniesWorked": int(df.iloc[i].get("NumCompaniesWorked", 0)),
            "education": int(df.iloc[i].get("Education", 1)),
            "educationField": str(df.iloc[i].get("EducationField", "")),
            "percentSalaryHike": int(df.iloc[i].get("PercentSalaryHike", 15)),
            "stockOptionLevel": int(df.iloc[i].get("StockOptionLevel", 0)),
            "totalWorkingYears": int(df.iloc[i].get("TotalWorkingYears", 0)),
            "trainingTimesLastYear": int(df.iloc[i].get("TrainingTimesLastYear", 0)),
            "businessTravel": str(df.iloc[i].get("BusinessTravel", "")),
            "performanceRating": int(df.iloc[i].get("PerformanceRating", 3)),
            "churnProbability": round(float(probas[i]), 4),
            "predictedChurn": int(preds[i]),
            "riskLevel": risk_label(probas[i], low_th, high_th),
            "deptAvgIncome": round(dept_incomes.get(dept, 0), 0),
        }
        if has_actual:
            emp["actualChurn"] = actuals[i]
        employees.append(emp)

    # populate store for interview routes
    employee_store.clear()
    for emp in employees:
        emp_id_norm = normalize_emp_id(emp.get("id"))
        if emp_id_norm is not None:
            employee_store[emp_id_norm] = emp

    # department stats
    dept_stats = {}
    for emp in employees:
        d = emp["department"]
        if d not in dept_stats:
            dept_stats[d] = {"total": 0, "high": 0, "medium": 0, "low": 0, "probSum": 0}
        dept_stats[d]["total"] += 1
        dept_stats[d][emp["riskLevel"].lower()] += 1
        dept_stats[d]["probSum"] += emp["churnProbability"]

    for d in dept_stats:
        dept_stats[d]["avgProb"] = round(dept_stats[d]["probSum"] / dept_stats[d]["total"], 4)

    ot_yes = [e["churnProbability"] for e in employees if e["overTime"] == "Yes"]
    ot_no = [e["churnProbability"] for e in employees if e["overTime"] == "No"]

    sat_stats = {}
    for emp in employees:
        s = emp["jobSatisfaction"]
        if s not in sat_stats:
            sat_stats[s] = {"total": 0, "probSum": 0, "highCount": 0}
        sat_stats[s]["total"] += 1
        sat_stats[s]["probSum"] += emp["churnProbability"]
        if emp["riskLevel"] == "HIGH":
            sat_stats[s]["highCount"] += 1

    wlb_stats = {}
    for emp in employees:
        w = emp["workLifeBalance"]
        if w not in wlb_stats:
            wlb_stats[w] = {"total": 0, "probSum": 0}
        wlb_stats[w]["total"] += 1
        wlb_stats[w]["probSum"] += emp["churnProbability"]

    total = len(employees)
    high_count = sum(1 for e in employees if e["riskLevel"] == "HIGH")
    med_count = sum(1 for e in employees if e["riskLevel"] == "MEDIUM")
    low_count = sum(1 for e in employees if e["riskLevel"] == "LOW")
    avg_prob = round(float(np.mean(probas)), 4)

    return jsonify({
        "summary": {
            "total": total,
            "highRisk": high_count,
            "mediumRisk": med_count,
            "lowRisk": low_count,
            "avgChurnProbability": avg_prob,
            "thresholds": {"low": round(low_th, 4), "high": round(high_th, 4)},
            "hasActual": has_actual,
        },
        "departmentStats": dept_stats,
        "overtimeStats": {
            "yesAvg": round(float(np.mean(ot_yes)), 4) if ot_yes else 0,
            "noAvg": round(float(np.mean(ot_no)), 4) if ot_no else 0,
            "yesCount": len(ot_yes),
            "noCount": len(ot_no),
        },
        "satisfactionStats": {
            str(k): {"avgProb": round(v["probSum"] / v["total"], 4), "total": v["total"], "highCount": v["highCount"]}
            for k, v in sorted(sat_stats.items())
        },
        "workLifeStats": {
            str(k): {"avgProb": round(v["probSum"] / v["total"], 4), "total": v["total"]}
            for k, v in sorted(wlb_stats.items())
        },
        "employees": sorted(employees, key=lambda e: e["churnProbability"], reverse=True),
    })


# ──────────────────────────────────────────────────────────────
# EXIT INTERVIEW ROUTES (protected)
# ──────────────────────────────────────────────────────────────
@app.route("/interview/start", methods=["POST"])
@login_required
def start_interview():
    data = request.json or {}
    emp_id = normalize_emp_id(data.get("employeeId"))

    if emp_id is None:
        return jsonify({"error": "Invalid employee id"}), 400

    if emp_id not in employee_store:
        return jsonify({"error": "Employee not found. Upload CSV first."}), 404

    emp = employee_store[emp_id]
    persona = build_persona(emp, emp.get("deptAvgIncome", 0))

    session_id = f"session_{emp_id}"
    interview_sessions[session_id] = {
        "employee": emp,
        "persona": persona,
        "messages": [{"role": "system", "content": persona}],
    }

    return jsonify({
        "sessionId": session_id,
        "employee": emp,
        "message": "Interview session started. You are the HR manager — begin the conversation.",
    })


@app.route("/interview/chat", methods=["POST"])
@login_required
def interview_chat():
    data = request.json or {}
    session_id = data.get("sessionId")
    user_msg = (data.get("message") or "").strip()

    if session_id not in interview_sessions:
        return jsonify({"error": "Session not found. Start an interview first."}), 404
    if not user_msg:
        return jsonify({"error": "Empty message"}), 400

    sess = interview_sessions[session_id]
    sess["messages"].append({"role": "user", "content": user_msg})

    try:
        reply = call_groq(sess["messages"])
        sess["messages"].append({"role": "assistant", "content": reply})
        return jsonify({"reply": reply})
    except Exception as e:
        return jsonify({"error": f"LLM error: {str(e)}"}), 500


@app.route("/interview/end", methods=["POST"])
@login_required
def end_interview():
    data = request.json or {}
    session_id = data.get("sessionId")

    if session_id not in interview_sessions:
        return jsonify({"error": "Session not found"}), 404

    sess = interview_sessions[session_id]
    if len(sess["messages"]) < 3:
        return jsonify({"error": "Too few messages. Have at least a few exchanges first."}), 400

    try:
        feedback = call_groq_feedback(sess["messages"], sess["employee"])
        del interview_sessions[session_id]
        return jsonify({"feedback": feedback})
    except Exception as e:
        return jsonify({"error": f"Feedback error: {str(e)}"}), 500


# ──────────────────────────────────────────────────────────────
# Run
# ──────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print("=" * 60)
    print("  ChurnGuard — Auth + Dashboard + Exit Interview Agent")
    print("  Welcome/Login:  http://localhost:5000/welcome")
    print("  Dashboard:      http://localhost:5000/")
    print("=" * 60)
    app.run(debug=True, port=5000)