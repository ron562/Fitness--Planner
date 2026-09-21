from flask import Flask, render_template, request

app = Flask(__name__)

MIN_CALORIES = {"male": 1500, "female": 1200}


def calculate_bmi(weight, height_cm):
    height_m = height_cm / 100
    bmi = weight / (height_m ** 2)

    if bmi < 18.5:
        category = "Underweight"
    elif bmi < 25:
        category = "Normal weight"
    elif bmi < 30:
        category = "Overweight"
    else:
        category = "Obese"

    return round(bmi, 2), category


def calculate_bmr(weight, height_cm, age, gender):
    # Mifflin-St Jeor Equation
    base = (10 * weight) + (6.25 * height_cm) - (5 * age)
    return base + 5 if gender == "male" else base - 161


def get_plans(goal):
    plans = {
        "lose": {
            "diet": [
                "Breakfast: Moong dal chilla with mint chutney, or vegetable poha",
                "Lunch: 2 multigrain rotis, dal, a bowl of sabzi and cucumber raita",
                "Dinner: Tandoori chicken or paneer tikka with sauteed vegetables and a small bowl of dal",
                "Snack: Roasted chana or sprouts chaat",
            ],
            "workout": [
                "Monday: 30 min Jogging",
                "Wednesday: HIIT Circuit (20 mins)",
                "Friday: Full body strength training",
                "Weekend: Active recovery (Walking)",
            ],
        },
        "gain": {
            "diet": [
                "Breakfast: Egg or paneer bhurji with 2 parathas and a glass of milk",
                "Lunch: Rice with rajma or chole, chicken or paneer curry, and curd",
                "Dinner: Palak paneer or chicken curry with 3 rotis and a bowl of dal",
                "Snack: Peanut chikki or mixed dry fruits with a glass of lassi",
            ],
            "workout": [
                "Monday: Heavy Squats & Legs",
                "Wednesday: Bench Press & Chest/Triceps",
                "Friday: Deadlifts & Back/Biceps",
                "Weekend: Rest",
            ],
        },
        "maintain": {
            "diet": [
                "Breakfast: Idli with sambar and coconut chutney, or vegetable upma",
                "Lunch: Rice or 2 rotis with dal tadka, mixed vegetable sabzi and salad",
                "Dinner: Chicken curry or paneer bhurji with 2 rotis and a side salad",
                "Snack: Fruit chaat or roasted makhana with a cup of chai",
            ],
            "workout": [
                "Monday: 45 min moderate cardio",
                "Wednesday: Bodyweight exercises",
                "Friday: Yoga/Pilates",
                "Weekend: Hiking or Sports",
            ],
        },
    }
    return plans.get(goal)


@app.route("/")
def index():
    return render_template("index.html", form={})


@app.route("/calculate", methods=["POST"])
def calculate():
    try:
        age = int(request.form["age"])
        gender = request.form["gender"]
        weight = float(request.form["weight"])
        height = float(request.form["height"])
        activity = float(request.form["activity"])
        goal = request.form["goal"]
    except (KeyError, ValueError):
        return render_template("index.html", form=request.form, error="Please fill in every field with valid numbers."), 400

    if not (10 <= age <= 100 and 20 <= weight <= 300 and 100 <= height <= 250):
        return render_template(
            "index.html",
            form=request.form,
            error="Please check your entries: age 10-100, weight 20-300 kg, height 100-250 cm.",
        ), 400

    plans = get_plans(goal)
    if gender not in MIN_CALORIES or plans is None:
        return render_template("index.html", form=request.form, error="Please choose a valid gender and goal."), 400

    bmi, bmi_category = calculate_bmi(weight, height)
    bmr = calculate_bmr(weight, height, age, gender)
    tdee = round(bmr * activity)

    # Adjust calories based on goal, never dropping below a safe minimum
    if goal == "lose":
        target_calories = max(tdee - 500, MIN_CALORIES[gender])
    elif goal == "gain":
        target_calories = tdee + 500
    else:
        target_calories = tdee

    return render_template(
        "result.html",
        bmi=bmi,
        category=bmi_category,
        bmr=round(bmr),
        tdee=tdee,
        target_calories=target_calories,
        goal=goal,
        diet=plans["diet"],
        workout=plans["workout"],
    )


if __name__ == "__main__":
    app.run(debug=True)
